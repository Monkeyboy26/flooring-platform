import { execSync } from 'child_process';
import fs from 'fs';
import {
  upsertProduct, upsertSku, upsertPricing, upsertPackaging, upsertSkuAttribute,
  appendLog, addJobError
} from './base.js';

/**
 * Emser Tile Price List PDF scraper.
 *
 * Parses the Emser dealer price list PDF (pdftotext -layout). Each series block has:
 *   1. Series name (ALL-CAPS at left margin)
 *   2. Material / technology / variation header lines
 *   3. PER CARTON packaging info (sqft, pcs, size)
 *   4. Section headings (FLOOR/WALL, WALL, MOSAIC, TRIM)
 *   5. Price rows: color at left, optional finish/design mid, price(s) aligned to size columns
 *
 * Multi-size series (e.g., 12X24 and 24X47 on same row) are handled via column-position
 * tracking — each size column gets its own size block and prices are matched by position.
 *
 * Creates full products, SKUs, pricing, packaging, and attributes.
 * Skips TRIM rows, Setting Materials, Bath Accessories, and @ (special order) items.
 */

const VENDOR_CODE = 'EMS';

// Lines to skip
const NOISE_PATTERNS = [
  /^NOTE:/i,
  /^\*MOSAIC MAY/,
  /^\*FOR ADDITIONAL/,
  /^\*POOL RATED/,
  /^FOR RESIN BACKED/,
  /^THE FOLLOWING ARE SETTING MATERIALS/,
  /^[\d]+\.\s*(CUSTOM|MERKRETE|TEC)\b/,
  /New Item.*check for availability/i,
  /All Pricing is FOB/i,
  /Shipments billed/i,
  /www\.EMSERTILE\.com/i,
  /^Page\s+\d+/i,
  /Confidential product list/i,
  /Prepared on:/i,
  /Effective:/i,
  /Full Color Catalog/i,
  /^\d{6}$/,
  /^PRICE LIST/,
  /^ROMA FLOORING/,
  /^The electronic version/,
  /information\. Please contact/,
  /Full color catalogs/,
  /Emser Tile sells all/,
  /This does not include trim/,
  /Prices herein supersede/,
  /EMSER'S SALES OFFICES/,
  /^BRANCH\s+ADDRESS/,
  /^BRANCH\s+LIST\b/,
  /^APPENDIX\b/i,
  /^APPENDICES$/,
  /^Check www\.EmserTile/,
  /^CORPORATE HEADQUARTERS/,
  /^Terms:/i,
  /^Pricing subject to change/,
  /^Pricing is FOB/,
  /^Dealer & Volume/,
  /^New Arrivals$/,
  /^NEW SERIES$/,
  /^NEW SIZES$/,
  /^SERIES NAME$/,
  /= NEW ITEM/,
  /CERAMIC\/?.*PORCELAIN.*\(CONT/i,
  /^CERAMIC\/\s*PORCELAIN TILE$/i,
  /^FLOOR TILE$/,
  /^FLOOR TILE \(WOOD LOOKS\)$/,
  /^WALL & COUNTER TILE/i,
  /^WALL TILE \(LARGE FORMAT\)/i,
  /^WALL & COUNTER TILE \(SMALL FORMAT\)/i,
  /^SUPPLEMENTARY$/,
  /^NATURAL STONE$/,
  /^DECORATIVE$/,
  /^DECORATIVE \(CONT/,
  /^EXPANSE$/,
  /^XTRA$/,
  /^LVT$/,
  /^QUARRY TILE$/,
  /^MARBLE & LIMESTONE$/,
  /^MARBLE & LIMESTONE \(CONT/,
  /^STONE LEDGERS$/,
  /^EXTERO$/,
  /PATTERN IS FOR REFERENCE ONLY/,
  /do not add up to 100%/,
  /An iteration of the Versailles/,
  /VERSAILLES PATTERN ORDER PERCENTAGES/,
  /Order % totals do not/,
  /^(FLOOR TILE|WALL TILE)\s*$/,
  /^CERAMIC\/?PORCELAIN/i,
  /NOTE:.*SOME MARBLES/i,
  /NOTE:.*LIMESTONE IS NOT/i,
  /^\* SOME MATERIAL MAYBE/,
];

export async function run(pool, job, source) {
  const pdfPath = source.config && source.config.pdf_path;
  if (!pdfPath) throw new Error('No file configured. Set config.pdf_path to the Emser price list PDF.');
  if (!fs.existsSync(pdfPath)) throw new Error(`File not found: ${pdfPath}`);

  await appendLog(pool, job.id, `Parsing Emser price list PDF: ${pdfPath}`);

  const rawText = extractPdfText(pdfPath);
  await appendLog(pool, job.id, `Extracted ${rawText.length} characters from PDF`);

  // Auto-create Emser Tile vendor if not present
  let vendorId = source.vendor_id;
  if (!vendorId) {
    const vendorResult = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Emser Tile', 'EMSER', 'https://www.emser.com')
      ON CONFLICT (code) DO NOTHING
      RETURNING id
    `);
    if (vendorResult.rows.length) {
      vendorId = vendorResult.rows[0].id;
    } else {
      const existing = await pool.query("SELECT id FROM vendors WHERE code = 'EMSER'");
      vendorId = existing.rows[0].id;
    }
  }
  await appendLog(pool, job.id, `Using vendor_id: ${vendorId}`);

  const catMap = await loadCategoryMap(pool);

  const series = parsePDF(rawText);
  const totalItems = series.reduce((sum, s) =>
    sum + s.sizeBlocks.reduce((bs, b) => bs + b.items.length, 0), 0
  );
  await appendLog(pool, job.id, `Parsed ${series.length} series, ${totalItems} total items`);

  if (totalItems === 0) throw new Error('No items found in PDF. Check format.');

  for (const s of series.slice(0, 5)) {
    const itemCount = s.sizeBlocks.reduce((sum, b) => sum + b.items.length, 0);
    await appendLog(pool, job.id,
      `  ${s.name} (${s.material || '?'}): ${s.sizeBlocks.length} size blocks, ${itemCount} items`
    );
  }

  let stats = {
    productsCreated: 0, productsUpdated: 0,
    skusCreated: 0, pricingSet: 0, packagingSet: 0, attributesSet: 0,
    errors: 0
  };

  for (let si = 0; si < series.length; si++) {
    const ser = series[si];
    const categoryId = resolveCategory(ser.material, ser.name, catMap);

    for (const block of ser.sizeBlocks) {
      for (const item of block.items) {
        try {
          await createItemSku(pool, vendorId, ser, block, item, categoryId, stats);
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 30) {
            await addJobError(pool, job.id,
              `${ser.name} / ${item.color} ${block.size}: ${err.message}`
            );
          }
        }
      }
    }

    if ((si + 1) % 30 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${si + 1}/${series.length} series, Products: ${stats.productsCreated}, SKUs: ${stats.skusCreated}`,
        { products_found: si + 1, products_created: stats.productsCreated, skus_created: stats.skusCreated }
      );
    }
  }

  await appendLog(pool, job.id,
    `Complete. Series: ${series.length}, Products: ${stats.productsCreated} new / ${stats.productsUpdated} updated, ` +
    `SKUs: ${stats.skusCreated}, Pricing: ${stats.pricingSet}, Packaging: ${stats.packagingSet}, ` +
    `Attributes: ${stats.attributesSet}, Errors: ${stats.errors}`,
    {
      products_found: totalItems,
      products_created: stats.productsCreated,
      products_updated: stats.productsUpdated,
      skus_created: stats.skusCreated
    }
  );
}

// ─── Product / SKU creation ──────────────────────────────────────────────────

async function createItemSku(pool, vendorId, series, block, item, categoryId, stats) {
  const collection = titleCase(series.name);
  const productName = titleCase(item.color);

  const product = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: productName,
    collection,
    category_id: categoryId,
  });
  if (product.is_new) stats.productsCreated++;
  else stats.productsUpdated++;

  const isSqft = block.unit === 'SF';
  const sellBy = isSqft ? 'sqft' : 'unit';
  const priceBasis = isSqft ? 'per_sqft' : 'per_unit';

  const sizeNorm = normalizeSize(block.size);
  const qualifiers = [item.finish, item.design].filter(Boolean);
  const variantName = [sizeNorm, ...qualifiers].join(', ') || sizeNorm;

  const skuParts = [VENDOR_CODE, slugify(series.name), slugify(item.color), slugify(block.size)];
  if (item.finish) skuParts.push(slugify(item.finish));
  if (item.design) skuParts.push(slugify(item.design));
  const internalSku = skuParts.join('-');

  const sku = await upsertSku(pool, {
    product_id: product.id,
    vendor_sku: item.vendorSku || null,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: sellBy,
    variant_type: item.section || null
  });
  if (sku.is_new) stats.skusCreated++;

  const emCost = parseFloat(item.price) || 0;
  await upsertPricing(pool, sku.id, {
    cost: emCost,
    retail_price: Math.round(emCost * 2 * 100) / 100,
    price_basis: priceBasis
  });
  stats.pricingSet++;

  if (block.sqftPerBox > 0 || block.pcsPerBox > 0) {
    const pkgData = {};
    if (block.sqftPerBox > 0) pkgData.sqft_per_box = block.sqftPerBox;
    if (block.pcsPerBox > 0) pkgData.pieces_per_box = block.pcsPerBox;
    await upsertPackaging(pool, sku.id, pkgData);
    stats.packagingSet++;
  }

  const attrs = [
    ['size', sizeNorm],
    ['color', productName],
    ['finish', item.finish],
    ['material', series.material],
    ['shade_variation', series.variationRating],
  ];
  for (const [slug, val] of attrs) {
    if (val) {
      await upsertSkuAttribute(pool, sku.id, slug, val);
      stats.attributesSet++;
    }
  }
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

// ─── PDF Parser ──────────────────────────────────────────────────────────────

/**
 * Parse entire price list text into structured series objects.
 *
 * Uses column-position tracking to handle multi-size series where a single
 * row contains prices for multiple sizes (e.g., 12X24 at col 90, 24X47 at col 110).
 */
function parsePDF(text) {
  const lines = text.split('\n');
  const allSeries = [];

  let currentSeries = null;
  let currentColumns = []; // [{block, charPos}] — active size columns with char positions
  let currentSection = null;
  let inSettingMaterials = false;
  let inTOC = false;
  let majorSection = '';
  let hasFinishCol = false;
  let hasDesignCol = false;

  // Pending packaging data from PER CARTON lines
  let pkgValues = []; // [{sqftPerBox, pcsPerBox}] — one per expected column

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Skip entire TABLE OF CONTENTS section (spans pages 2-6, may repeat headers)
    if (/^TABLE OF CONTENTS/i.test(trimmed)) { inTOC = true; continue; }
    if (inTOC) {
      if (/^APPENDIX|^APPENDICES$/i.test(trimmed)) inTOC = false;
      continue;
    }

    if (isNoiseLine(trimmed)) continue;

    // Skip branch listing lines (contain phone numbers like (714) 778-5777)
    if (/\(\d{3}\)\s*\d{3}[\s-]?\d{4}/.test(trimmed)) continue;

    // Skip TOC lines (end with a page number after wide spacing, no decimal prices)
    // Handles both standalone page numbers ("78") and concatenated ("Page866")
    if (/\s{3,}(Page\s*)?\d{1,3}(-\d{1,3})?\s*$/.test(trimmed) && !/\d+\.\d{2}/.test(trimmed)) continue;

    // ── Stop at setting materials / essentials ──
    if (/^EMSER ESSENTIALS/i.test(trimmed) || /^EMPERVIOUS/i.test(trimmed) ||
        /^PRIVADO/i.test(trimmed)) {
      // PRIVADO is a budget/builder line, include it as a series
      if (/^PRIVADO/i.test(trimmed)) {
        currentSeries = { name: 'PRIVADO', material: null, variationRating: null, sizeBlocks: [] };
        allSeries.push(currentSeries);
        currentColumns = [];
        currentSection = null;
        pkgValues = [];
        hasFinishCol = false;
        hasDesignCol = false;
        continue;
      }
      inSettingMaterials = true;
      continue;
    }
    if (inSettingMaterials) continue;

    // Skip setting-material-style tabular data
    if (isSettingMaterialLine(trimmed)) continue;

    // Skip @ items (special order / MOQ)
    if (trimmed.includes('@')) continue;

    // Skip bare page numbers
    if (/^\d{1,3}$/.test(trimmed)) continue;

    // Skip branch listing lines
    if (/^[A-Z]+\s{3,}\d+\s/.test(trimmed) && /\d{5}/.test(trimmed)) continue;

    // Skip lines with $ (price list item codes with dollar amounts)
    if (/\$\s*[\d,]+\.\d{2}/.test(trimmed)) continue;

    // Compute stripped line early (strips trailing ONLINE links, "New Arrivals", etc.)
    // Used for series header detection throughout
    const strippedLine = trimmed.replace(/\s{3,}.*$/, '').trim();
    const lineHasPrice = /\d+\.\d{2}/.test(trimmed);

    // ── Major section headers ──
    // Skip TOC lines (they contain commas like "12X24, 18X18, 24X24   78")
    const isTocLine = /,/.test(trimmed) && /\d{1,3}\s*$/.test(trimmed);

    if (!isTocLine && /^ANTIQUE\s*&?\s*TUMBLED\s*STONE/i.test(trimmed)) { majorSection = 'STONE'; continue; }
    if (!isTocLine && /^TRAVERTINE\s*[-–]?\s*(CROSSCUT|VEINCUT)/i.test(trimmed) && !/RATING/i.test(trimmed)) {
      majorSection = 'STONE';
      const name = trimmed.replace(/\s{3,}.*$/, '').trim(); // strip trailing Online link
      currentSeries = { name, material: 'Travertine', variationRating: null, sizeBlocks: [] };
      allSeries.push(currentSeries);
      currentColumns = []; currentSection = null; pkgValues = [];
      hasFinishCol = false; hasDesignCol = false;
      continue;
    }
    if (!isTocLine && /^GRANITE\s*[-–]?\s*POLISHED/i.test(trimmed) && !/RATING/i.test(trimmed)) {
      majorSection = 'STONE';
      const name = trimmed.replace(/\s{3,}.*$/, '').trim();
      currentSeries = { name, material: 'Granite', variationRating: null, sizeBlocks: [] };
      allSeries.push(currentSeries);
      currentColumns = []; currentSection = null; pkgValues = [];
      hasFinishCol = false; hasDesignCol = false;
      continue;
    }
    if (!isTocLine && /^SLATE,?\s*QUARTZITE/i.test(trimmed)) {
      majorSection = 'STONE';
      const name = trimmed.replace(/\s{3,}.*$/, '').trim();
      currentSeries = { name, material: 'Slate/Quartzite', variationRating: null, sizeBlocks: [] };
      allSeries.push(currentSeries);
      currentColumns = []; currentSection = null; pkgValues = [];
      hasFinishCol = false; hasDesignCol = false;
      continue;
    }
    if (!isTocLine && /^MARBLE\s*&?\s*LIMESTONE\s*\(POLISHED/i.test(trimmed)) {
      majorSection = 'STONE'; continue;
    }
    if (/^MARBLE\s*&?\s*LIMESTONE$/i.test(trimmed)) { majorSection = 'STONE'; continue; }
    if (/^STONE LEDGERS$/i.test(trimmed)) { majorSection = 'STONE_LEDGER'; continue; }
    if (/^EXTERO$/i.test(trimmed)) { majorSection = 'STONE'; continue; }

    // ── TRIM — skip until next section change ──
    if (/^TRIM\b/i.test(trimmed) && !/TRIM\s+ALUMINUM/i.test(trimmed)) {
      currentSection = 'TRIM';
      continue;
    }
    if (currentSection === 'TRIM') {
      // Stay in TRIM until we hit a new section, series, or PER CARTON
      if (!(!lineHasPrice && isSeriesHeader(line, strippedLine)) &&
          !/PER CARTON/i.test(trimmed) && !isSectionHeader(trimmed)) {
        continue;
      }
      // Fall through to handle the new section/series/PER CARTON
      currentSection = null;
    }

    // ── BATH ACCESSORIES — skip ──
    if (/^BATH ACCESSORIES/i.test(trimmed)) {
      currentSection = 'SKIP';
      continue;
    }
    if (/^SHOWER CORNER/i.test(trimmed)) continue;
    if (currentSection === 'SKIP') {
      if ((!lineHasPrice && isSeriesHeader(line, strippedLine)) ||
          /PER CARTON/i.test(trimmed) || isSectionHeader(trimmed)) {
        currentSection = null;
      } else {
        continue;
      }
    }

    // ── Corner sections — skip (per-piece accessories) ──
    if (/^3D LEDGER CORNER/i.test(trimmed) || /^STACKED LEDGER CORNER/i.test(trimmed) ||
        /^MINI STACKED.*CORNER/i.test(trimmed)) {
      currentSection = 'TRIM';
      continue;
    }

    // ── PER CARTON — gather packaging info ──
    if (/PER CARTON/i.test(trimmed)) {
      // Material info is often on the same line as PER CARTON
      // e.g., "GLAZED PORCELAIN FLOOR / CERAMIC WALL                PER CARTON"
      if (currentSeries && !currentSeries.material) {
        let beforePer = trimmed.replace(/\s*PER\s+CARTON.*$/i, '').trim();
        // Strip out noise: "NEW SERIES", "NEW SIZES", "NEW COLORS", "(SF)", "(PC)", etc.
        beforePer = beforePer.replace(/\bNEW\s+(SERIES|SIZES?|COLORS?|HENNA\s+SIZES?)\b/gi, '').trim();
        beforePer = beforePer.replace(/\((?:SF|PC)\)/gi, '').trim();
        beforePer = beforePer.replace(/\s{2,}/g, ' ').trim();
        if (beforePer && /PORCELAIN|CERAMIC|QUARRY|LVT|VINYL/i.test(beforePer)) {
          currentSeries.material = titleCase(beforePer);
        }
      }
      pkgValues = [{ sqftPerBox: 0, pcsPerBox: 0 }];
      // Inline values on same line
      const sfVals = [...trimmed.matchAll(/([\d.]+)\s*SF/g)];
      const pcVals = [...trimmed.matchAll(/(\d+)\s*PC/g)];
      if (sfVals.length > 0) {
        pkgValues = sfVals.map((m, idx) => ({
          sqftPerBox: parseFloat(m[1]),
          pcsPerBox: pcVals[idx] ? parseInt(pcVals[idx][1], 10) : 0
        }));
      }
      continue;
    }

    // ── Packaging data lines (SF / PC values after PER CARTON) ──
    if (pkgValues.length > 0 && currentSection !== 'TRIM') {
      // Also extract variation rating if on same line as packaging
      // e.g., "VARIATION RATING: V4                      6 PC"
      if (/VARIATION\s+RATING/i.test(trimmed) && currentSeries) {
        const vrMatch = trimmed.match(/VARIATION\s+RATING:\s*(V\d+)/i);
        if (vrMatch) currentSeries.variationRating = vrMatch[1].toUpperCase();
      }

      // Multi or single SF values: "11.472 SF   15.372 SF"
      const sfVals = [...trimmed.matchAll(/([\d.]+)\s*SF/g)];
      if (sfVals.length > 0) {
        for (let j = 0; j < sfVals.length; j++) {
          if (!pkgValues[j]) pkgValues[j] = { sqftPerBox: 0, pcsPerBox: 0 };
          pkgValues[j].sqftPerBox = parseFloat(sfVals[j][1]);
        }
        continue;
      }
      // Multi or single PC values: "6 PC   2 PC"
      const pcVals = [...trimmed.matchAll(/(\d+)\s*PC/g)];
      if (pcVals.length > 0) {
        for (let j = 0; j < pcVals.length; j++) {
          if (!pkgValues[j]) pkgValues[j] = { sqftPerBox: 0, pcsPerBox: 0 };
          pkgValues[j].pcsPerBox = parseInt(pcVals[j][1], 10);
        }
        continue;
      }
      if (/^varies$/i.test(trimmed) || /^tbd$/i.test(trimmed)) continue;
    }

    // ── Size header line ──
    // Match lines that contain size patterns like "12X24", "24X47", "9X11 HEX"
    // but NOT section headers, price rows, or accessory columns
    if (isSizeHeaderLine(line, trimmed)) {
      if (!currentSeries) continue;

      // Extract sizes and their character positions from the ORIGINAL line
      const sizeMatches = [...line.matchAll(/(\d+X\d+(?:\s+HEX)?)/gi)];
      if (sizeMatches.length === 0) continue;

      // Filter out accessory column sizes (TMOLD position, etc.)
      // Only take sizes that aren't part of "ON MESH" or accessory headers
      const newColumns = [];
      for (let j = 0; j < sizeMatches.length; j++) {
        const m = sizeMatches[j];
        const size = m[1];
        const charPos = m.index;
        const pkg = pkgValues[j] || { sqftPerBox: 0, pcsPerBox: 0 };
        const block = {
          size,
          unit: 'SF',
          sqftPerBox: pkg.sqftPerBox || 0,
          pcsPerBox: pkg.pcsPerBox || 0,
          items: []
        };
        currentSeries.sizeBlocks.push(block);
        newColumns.push({ block, charPos });
      }

      currentColumns = newColumns;
      currentSection = null;
      hasFinishCol = false;
      hasDesignCol = false;
      pkgValues = [];
      continue;
    }

    // ── Unit header: "(SF)" or "(PC)" ──
    // Can be multi-column: "    (SF)        (SF)"
    const unitMatches = [...line.matchAll(/\((SF|PC)\)/gi)];
    if (unitMatches.length > 0 && trimmed.match(/^\(?(?:SF|PC)\)?(\s+\(?(?:SF|PC)\)?)*$/i)) {
      for (const um of unitMatches) {
        const unit = um[1].toUpperCase();
        const pos = um.index;
        const nearest = findNearestColumn(currentColumns, pos);
        if (nearest) nearest.block.unit = unit;
      }
      continue;
    }

    // ── "ON MESH" lines ──
    if (/ON\s*MESH/i.test(trimmed)) {
      // Extract size from context if present (e.g., "1X2 ON MESH")
      const meshSize = trimmed.match(/(\d+X\d+)\s+ON\s*MESH/i);
      if (currentSeries && (currentSection === 'MOSAIC' || currentSection === 'LEDGER')) {
        const size = meshSize ? meshSize[1] : 'MOSAIC';
        const block = { size, unit: 'SF', sqftPerBox: 0, pcsPerBox: 0, items: [] };
        currentSeries.sizeBlocks.push(block);
        currentColumns = [{ block, charPos: line.indexOf(trimmed) }];
        if (trimmed.includes('(SF)')) block.unit = 'SF';
        if (trimmed.includes('(PC)')) block.unit = 'PC';
      }
      continue;
    }

    // ── Section type headers ──
    if (isSectionHeader(trimmed)) {
      const sec = classifySection(trimmed);
      if (sec) {
        currentSection = sec;
        hasFinishCol = /FINISH/i.test(trimmed);
        hasDesignCol = /DESIGN/i.test(trimmed);

        // Handle inline unit markers on section header lines
        // (e.g., LVT: "FLOOR    (SF)    (PC)    (PC)" or stone: "GRANITE - POLISHED RATING (SF) (SF)")
        const inlineUnits = [...line.matchAll(/\((SF|PC)\)/gi)];
        if (inlineUnits.length > 0 && currentColumns.length > 0) {
          for (let j = 0; j < inlineUnits.length && j < currentColumns.length; j++) {
            currentColumns[j].block.unit = inlineUnits[j][1].toUpperCase();
          }
        }

        // Create a mosaic block if entering mosaic section without size header
        if (sec === 'MOSAIC' && currentSeries && currentColumns.length === 0) {
          const block = { size: 'MOSAIC', unit: 'SF', sqftPerBox: 0, pcsPerBox: 0, items: [] };
          currentSeries.sizeBlocks.push(block);
          currentColumns = [{ block, charPos: 0 }];
        }
      }
      continue;
    }

    // ── Standalone FINISH / DESIGN column headers ──
    if (/^FINISH$/i.test(trimmed)) { hasFinishCol = true; continue; }
    if (/^DESIGN$/i.test(trimmed)) { hasDesignCol = true; continue; }
    if (/^V\s*$/i.test(trimmed) || /^V\s+RATING$/i.test(trimmed) || /^RATING$/i.test(trimmed)) continue;

    // ── Material / technology / variation lines ──
    if (isMetadataLine(trimmed)) {
      if (currentSeries) {
        const matMatch = trimmed.match(/(GLAZED\s+)?(BODY\s+MATCH\s+)?(PORCELAIN|CERAMIC|UNGLAZED\s+QUARRY\s+TILE)[^$]*/i);
        if (matMatch && !currentSeries.material) {
          let mat = trimmed.replace(/\s+/g, ' ').trim();
          // Strip noise from material string
          mat = mat.replace(/\bNEW\s+(SERIES|SIZES?|COLORS?|HENNA\s+SIZES?)\b/gi, '').trim();
          mat = mat.replace(/\((?:SF|PC)\)/gi, '').trim();
          mat = mat.replace(/\bFINISH\b/gi, '').trim();
          mat = mat.replace(/\bDESIGN\b/gi, '').trim();
          mat = mat.replace(/\s{2,}/g, ' ').trim();
          currentSeries.material = titleCase(mat);
        }
        const varMatch = trimmed.match(/VARIATION\s+RATING:\s*(V\d+)/i);
        if (varMatch) currentSeries.variationRating = varMatch[1].toUpperCase();
      }
      continue;
    }

    // ── LVT accessory column headers — skip ──
    if (/^(TMOLD|ECAP|REDUC|F-STR|QTR\s*RND|STAIR|RISER)/i.test(trimmed)) continue;
    // Skip compound header lines with accessory columns
    if (/TMOLD|ECAP|REDUC|F-STR|QTR\s*RND/i.test(trimmed) && !trimmed.match(/\d+\.\d{2}\s*$/)) continue;

    // ── VERSAILLES PATTERN lines ──
    if (/^VERSAILLES\s+PATTERN/i.test(trimmed)) {
      if (currentSeries) {
        const block = { size: 'VERSAILLES', unit: 'SF', sqftPerBox: 0, pcsPerBox: 0, items: [] };
        currentSeries.sizeBlocks.push(block);
        currentColumns = [{ block, charPos: line.indexOf(trimmed) + trimmed.length - 10 }];
      }
      continue;
    }
    // Skip Versailles order percentage data lines
    if (/^[A-D]\s+\d+X\d+/.test(trimmed)) continue;

    // ── BANDED SET line ──
    if (/^BANDED\s+SET/i.test(trimmed)) {
      if (currentSeries) {
        const block = { size: 'BANDED SET', unit: 'SF', sqftPerBox: 0, pcsPerBox: 0, items: [] };
        currentSeries.sizeBlocks.push(block);
        currentColumns = [{ block, charPos: line.indexOf(trimmed) + trimmed.length - 5 }];
      }
      continue;
    }

    // ── Series header detection ──
    // Only consider as series header if original line has NO price
    // (price rows like "INDIGO   MATTE   4.93" would also strip to just "INDIGO")
    if (!lineHasPrice && isSeriesHeader(line, strippedLine)) {
      // Continuation — e.g., "EMCORE (CONT.)"
      const contMatch = strippedLine.match(/^([A-Z][A-Z\s&\-]+?)\s*\(CONT\.?\)/);
      if (contMatch) {
        const contName = contMatch[1].trim();
        const existing = allSeries.find(s => s.name === contName);
        if (existing) {
          currentSeries = existing;
          currentColumns = [];
          currentSection = null;
          pkgValues = [];
          hasFinishCol = false;
          hasDesignCol = false;
          continue;
        }
      }

      const seriesName = strippedLine.replace(/\s*\(CONT\.?\)/, '').trim();

      currentSeries = {
        name: seriesName,
        material: null,
        variationRating: null,
        sizeBlocks: []
      };

      // Set material from major section context
      if (majorSection === 'STONE' || majorSection === 'STONE_LEDGER') {
        currentSeries.material = detectStoneMaterial(seriesName);
      }

      allSeries.push(currentSeries);
      currentColumns = [];
      currentSection = null;
      pkgValues = [];
      hasFinishCol = false;
      hasDesignCol = false;
      continue;
    }

    // ── Price row parsing ──
    if (!currentSeries || currentColumns.length === 0) continue;

    const items = parsePriceRow(line, trimmed, hasFinishCol, hasDesignCol, currentSection, majorSection, currentColumns);
    if (items) {
      for (const { colIdx, item } of items) {
        if (colIdx < currentColumns.length && item.price > 0) {
          currentColumns[colIdx].block.items.push(item);
        }
      }
    }
  }

  return allSeries;
}

// ─── Line classifiers ────────────────────────────────────────────────────────

function isNoiseLine(trimmed) {
  return NOISE_PATTERNS.some(p => p.test(trimmed));
}

function isSettingMaterialLine(t) {
  return (
    /^Item\s+#/i.test(t) || /^Description$/i.test(t) ||
    /^(Pack|Pallet|Case)\s+Quantity/i.test(t) ||
    /^Clips$/i.test(t) || /^Wedges$/i.test(t) || /^Pliers$/i.test(t) ||
    /^Membrane$/i.test(t) || /^Primer$/i.test(t) ||
    /^Adapters/i.test(t) || /^Universal Shower/i.test(t) ||
    /^Foamboard$/i.test(t) || /^Shower Curbs$/i.test(t) ||
    /^Niches/i.test(t) || /^Accessories\s*&/i.test(t) ||
    /^Z[A-Z]{2}[A-Z0-9\-]+\s/i.test(t) || // Emser item codes start with Z
    /^Designed to/i.test(t) || /^accommodate curb/i.test(t) ||
    /^Includes Brass/i.test(t) || /^Strainer/i.test(t) ||
    /^Putty Knives/i.test(t)
  );
}

function isMetadataLine(trimmed) {
  return (
    /^(GLAZED\s+)?(BODY\s+MATCH\s+)?(PORCELAIN|CERAMIC)/i.test(trimmed) && !trimmed.match(/\d+\.\d{2}/) ||
    /^UNGLAZED\s+QUARRY/i.test(trimmed) ||
    /^HD TECHNOLOGY/i.test(trimmed) ||
    /^VARIATION\s+RATING/i.test(trimmed) ||
    /^6MM GLAZED/i.test(trimmed) ||
    /^2CM GLAZED/i.test(trimmed)
  );
}

/**
 * Check if a line is a size header (e.g., "12X24" or "12X24     24X47")
 * Also allows LVT-style compound headers like "7X48   TMOLD   ECAP   REDUC"
 * (we extract only the size patterns from these)
 */
function isSizeHeaderLine(line, trimmed) {
  // Must contain at least one size pattern
  if (!/\d+X\d+/i.test(trimmed)) return false;
  // Must NOT contain a price (decimal number at end)
  if (/\d+\.\d{2}\s*$/.test(trimmed)) return false;
  // Must NOT contain $ (dollar amounts)
  if (trimmed.includes('$')) return false;
  // Must NOT be a MOSAIC description (MOSAIC 2X2 SOLID)
  if (/^MOSAIC\s+\d+X\d+/i.test(trimmed)) return false;
  // Must NOT be a trim item (FLOOR SBN 3X12)
  if (/SBN|COVE|CORNER|COPING/i.test(trimmed)) return false;
  // Must NOT be a section header we handle elsewhere
  if (/ON\s*MESH/i.test(trimmed)) return false;
  if (/PER CARTON/i.test(trimmed)) return false;
  // Must NOT be a TOC line (TOC entries have commas for size lists)
  if (/,/.test(trimmed)) return false;
  // Must have the size(s) indented (not at left margin — that's TOC)
  const firstSizePos = line.search(/\d+X\d+/i);
  if (firstSizePos < 20) return false;

  return true;
}

/**
 * Classify a section header line.
 */
function isSectionHeader(trimmed) {
  return classifySection(trimmed) !== null;
}

function classifySection(trimmed) {
  if (/^FLOOR\/?WALL\b/i.test(trimmed)) return 'FLOOR/WALL';
  if (/^GLAZED\s+(PORCELAIN\s+)?FLOOR\/?WALL\b/i.test(trimmed)) return 'FLOOR/WALL';
  if (/^GLAZED\s+(PORCELAIN|CERAMIC)\s+MOSAIC/i.test(trimmed)) return 'MOSAIC';
  if (/^(STONE|GROUTLESS\s+STONE|UNGLAZED\s+PORCELAIN)\s+MOSAIC/i.test(trimmed)) return 'MOSAIC';
  if (/^GLAZED\s+MOSAIC/i.test(trimmed)) return 'MOSAIC';
  if (/^GLAZED\s+WALL\s+TILE/i.test(trimmed)) return 'WALL';
  if (/^WALL\b/i.test(trimmed) && !/\d+\.\d{2}/.test(trimmed)) return 'WALL';
  if (/^FLOOR\b/i.test(trimmed) && !/SBN/i.test(trimmed) && !/\d+\.\d{2}/.test(trimmed) && !trimmed.includes('$')) return 'FLOOR';
  if (/^MOSAIC\b/i.test(trimmed) && !/\d+\.\d{2}/.test(trimmed)) return 'MOSAIC';
  if (/^ABRASIVE\b/i.test(trimmed)) return 'FLOOR/WALL';
  if (/^GLUE\s*DOWN\b/i.test(trimmed)) return 'FLOOR';
  if (/^(3D|STACKED)\s+LEDGER\b/i.test(trimmed) && !/CORNER/i.test(trimmed)) return 'LEDGER';
  if (/^MINI\s+STACKED\s+(LEDGER|SLATE)/i.test(trimmed) && !/CORNER/i.test(trimmed)) return 'LEDGER';
  if (/^FIELD\s+TILE/i.test(trimmed)) return 'FIELD';
  if (/^(FILLED\s+AND\s+HONED|CALIBRATED|MARBLE\s+POLISHED|STONE\s+FLUTED)/i.test(trimmed)) return 'FIELD';
  if (/^3CM\b/i.test(trimmed) && !/\d+\.\d{2}/.test(trimmed)) return 'FIELD';
  if (/^MARBLE\s+TRIMS/i.test(trimmed)) return 'TRIM';
  if (/^TRIMS\/?MOSAICS/i.test(trimmed)) return 'TRIM';
  if (/^METRO\s+MOSAIC/i.test(trimmed)) return 'MOSAIC';
  if (/^STONE\s+MOSAIC\s+PATTERNS/i.test(trimmed)) return 'MOSAIC';
  // Stone section subheaders (e.g., "GRANITE - POLISHED  RATING  (SF)  (SF)")
  if (/^(GRANITE|TRAVERTINE|SLATE)\s*[-–]/i.test(trimmed) && !/\d+\.\d{2}/.test(trimmed)) return 'FIELD';
  return null;
}

/**
 * Determine if a line is a series header.
 */
function isSeriesHeader(line, trimmed) {
  const leadingSpaces = line.match(/^(\s*)/)[1].length;
  if (leadingSpaces > 10) return false;

  // Must start with uppercase letter and be mostly uppercase
  if (!/^[A-Z][A-Z\s\-&'\/II]+$/.test(trimmed)) return false;

  // Must not be a known keyword
  const knownStarts = [
    'FLOOR/WALL', 'FLOOR', 'WALL', 'MOSAIC', 'TRIM', 'ABRASIVE', 'GLUE DOWN',
    'GLAZED', 'PORCELAIN', 'CERAMIC', 'HD TECHNOLOGY', 'VARIATION RATING',
    'PER CARTON', 'ON MESH', 'FINISH', 'DESIGN', 'NOTE:', 'FIELD TILE',
    'MARBLE POLISHED', 'MARBLE TRIMS', 'TRIMS/MOSAICS', 'FILLED AND HONED',
    'CALIBRATED', '3D LEDGER', 'STACKED LEDGER', 'MINI STACKED', '3CM',
    'STONE FLUTED', 'VERSAILLES PATTERN', 'BANDED', 'LOOSE',
    'METRO MOSAIC', 'METRO VEINCUT', 'METRO CREAM', 'METRO GRAY', 'METRO BLUE',
    'STONE MOSAIC', 'BATH ACCESSORIES', 'SHOWER CORNER',
    'BLOOM', 'RIPPLE', // Sub-sections in JAZZ
    'NAVE', // Sub-section in FLUTIQUE (NAVE ALBA, etc.)
  ];
  if (knownStarts.some(k => trimmed.startsWith(k))) return false;

  // Must not contain a price
  if (/\d+\.\d{2}/.test(trimmed)) return false;
  // Must not be a unit line
  if (/^\(\w+\)$/.test(trimmed)) return false;
  // Length constraints
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  // Must not start with a digit (size headers)
  if (/^\d/.test(trimmed)) return false;
  // Must contain a 3+ char alpha sequence
  if (!/[A-Z]{3,}/.test(trimmed)) return false;

  return true;
}

// ─── Price row parsing ───────────────────────────────────────────────────────

/**
 * Parse a price row, extracting items for each column.
 * Returns array of {colIdx, item} or null if not a price row.
 */
function parsePriceRow(line, trimmed, hasFinishCol, hasDesignCol, section, majorSection, columns) {
  // Must contain at least one decimal price
  if (!/\d+\.\d{2}/.test(trimmed)) return null;

  // Skip trim/cove/sbn items
  if (/\bSBN\b|\bCOVE\b|\bCORNER\b|\bCOPING\b|\bJOLLY\b/i.test(trimmed)) return null;

  // Find all decimal numbers in the line and their char positions
  const priceMatches = [...line.matchAll(/([\d,]+\.\d{2})/g)];
  if (priceMatches.length === 0) return null;

  // Extract the color/label portion — everything before the first price
  const firstPricePos = priceMatches[0].index;
  const labelPart = line.slice(0, firstPricePos).trim();
  if (!labelPart) return null;

  // Parse color, finish, design from label
  const { color, finish, design, vendorSku } = parseLabel(
    labelPart, hasFinishCol, hasDesignCol, section, majorSection
  );
  if (!color) return null;

  // Match each price to its nearest column
  const results = [];
  for (const pm of priceMatches) {
    const price = parseFloat(pm[1].replace(/,/g, ''));
    if (price <= 0 || isNaN(price)) continue;
    const pricePos = pm.index;

    // Find the nearest column by character position
    let bestCol = 0;
    let bestDist = Infinity;
    for (let ci = 0; ci < columns.length; ci++) {
      const dist = Math.abs(pricePos - columns[ci].charPos);
      if (dist < bestDist) {
        bestDist = dist;
        bestCol = ci;
      }
    }

    // Only accept if within reasonable distance (50 chars)
    if (bestDist <= 50) {
      // For LVT rows with accessory columns, only take prices that map to
      // actual tile size columns (skip TMOLD, ECAP, etc. which are beyond the last column)
      results.push({
        colIdx: bestCol,
        item: {
          color,
          finish: finish || null,
          design: design || null,
          price,
          section: section || 'FLOOR/WALL',
          vendorSku: vendorSku || null,
        }
      });
    }
  }

  // Deduplicate: if multiple prices mapped to same column, keep the closest one
  const byCol = new Map();
  for (const r of results) {
    if (!byCol.has(r.colIdx)) {
      byCol.set(r.colIdx, r);
    }
  }

  return byCol.size > 0 ? [...byCol.values()] : null;
}

/**
 * Extract color, finish, design, vendorSku from the label portion of a price row.
 */
function parseLabel(label, hasFinishCol, hasDesignCol, section, majorSection) {
  let color = null, finish = null, design = null, vendorSku = null;

  // Strip PUA characters (font symbols from pdftotext) and normalize whitespace
  const cleanLabel = label.replace(/[\uE000-\uF8FF]/g, '').replace(/[\s\u00A0]+/g, ' ');

  // Split on 2+ spaces to separate columns
  const parts = cleanLabel.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { color, finish, design, vendorSku };

  if (section === 'MOSAIC' || /^MOSAIC\b/i.test(parts[0])) {
    // Mosaic: "MOSAIC 2X2 SOLID*" or just "SPLITFACE OFFSET SILVER"
    color = parts.join(' ').replace(/\*+$/, '').trim();
  } else if (majorSection === 'STONE' || majorSection === 'STONE_LEDGER') {
    // Natural stone: may have V-rating, stone code, material type mixed in
    const colorParts = [];
    for (const p of parts) {
      if (/^V\d$/i.test(p)) continue; // skip V-rating
      if (/^[A-Z]{2}\d+[A-Z]*$/i.test(p) && p.length >= 4 && p.length <= 12) {
        vendorSku = p; // stone item code like GR10A
      } else if (/^(MARBLE|LIMESTONE|TRAVERTINE|QUARTZITE|GRANITE|SLATE)$/i.test(p)) {
        // material column — skip (already captured at series level)
        continue;
      } else {
        colorParts.push(p);
      }
    }
    color = colorParts.join(' ').trim();
  } else if (hasDesignCol) {
    color = parts[0];
    if (parts.length >= 2) design = titleCase(parts[parts.length - 1]);
  } else if (hasFinishCol) {
    color = parts[0];
    if (parts.length >= 2) {
      const lastPart = parts[parts.length - 1];
      // Check if last part is a known finish
      if (/^(MATTE|POLISHED|HONED|GLOSS|LAPPATO|FLAT|STRUCTURE|SATIN|GLOSSY|HIGH|SMOOTH|3D)$/i.test(lastPart)) {
        finish = titleCase(lastPart);
      } else if (parts.length >= 3 && /^(MATTE|POLISHED|HONED|GLOSS|LAPPATO|FLAT|STRUCTURE)$/i.test(parts[1])) {
        finish = titleCase(parts[1]);
      }
    }
  } else {
    // No finish/design column — just color name
    // LVT: "MITFORD ALISO     5MM/12MIL" — skip the spec
    if (parts.length >= 2 && /^\d+MM\/\d+MIL$/i.test(parts[parts.length - 1])) {
      color = parts.slice(0, -1).join(' ');
    } else if (parts.length >= 2 && /^\d+MM\/\d+MIL$/i.test(parts[1])) {
      color = parts[0];
    } else {
      color = parts[0];
    }
  }

  return { color, finish, design, vendorSku };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findNearestColumn(columns, charPos) {
  let best = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const dist = Math.abs(charPos - col.charPos);
    if (dist < bestDist) {
      bestDist = dist;
      best = col;
    }
  }
  return bestDist <= 50 ? best : null;
}

function detectStoneMaterial(name) {
  const n = name.toUpperCase();
  if (n.includes('TRAV')) return 'Travertine';
  if (n.includes('GRANITE')) return 'Granite';
  if (n.includes('MARBLE')) return 'Marble';
  if (n.includes('LIMESTONE')) return 'Limestone';
  if (n.includes('SLATE')) return 'Slate';
  if (n.includes('QUARTZITE')) return 'Quartzite';
  if (n.includes('SANDSTONE')) return 'Sandstone';
  if (n.includes('STRUCTURE')) return 'Natural Stone';
  if (n.includes('FLUTIQUE')) return 'Natural Stone';
  return 'Natural Stone';
}

async function loadCategoryMap(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const map = {};
  for (const row of result.rows) map[row.slug] = row.id;
  return map;
}

function resolveCategory(material, seriesName, catMap) {
  const combined = ((material || '') + ' ' + (seriesName || '')).toLowerCase();

  if (combined.includes('lvt') || combined.includes('emcore') || combined.includes('vinyl'))
    return catMap['luxury-vinyl'] || null;
  if (combined.includes('mosaic') || combined.includes('glass') || combined.includes('pebble'))
    return catMap['mosaic-tile'] || null;
  if (combined.includes('quarry'))
    return catMap['ceramic-tile'] || null;
  if (combined.includes('ledger'))
    return catMap['natural-stone'] || null;
  if (combined.includes('marble') || combined.includes('travertine') ||
      combined.includes('granite') || combined.includes('slate') ||
      combined.includes('quartzite') || combined.includes('limestone') ||
      combined.includes('sandstone') || combined.includes('stone'))
    return catMap['natural-stone'] || null;
  if (combined.includes('porcelain') || combined.includes('ceramic'))
    return catMap['porcelain-tile'] || null;

  return catMap['porcelain-tile'] || null;
}

function normalizeSize(raw) {
  if (!raw) return '';
  return raw.replace(/["″'']/g, '').replace(/\s*[xX×]\s*/g, 'x').trim().toLowerCase();
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleCase(s) {
  if (!s) return s;
  // Normalize all whitespace and strip PUA characters from pdftotext (U+E000–U+F8FF)
  const cleaned = s.replace(/[\uE000-\uF8FF]/g, '').replace(/[\s\u00A0\u2000-\u200B]+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map(w => {
      if (w.length <= 2 && /^[ivxlcdm]+$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}
