import { execSync } from 'child_process';
import fs from 'fs';
import {
  upsertProduct, upsertSku, upsertPricing, upsertPackaging, upsertSkuAttribute,
  appendLog, addJobError, normalizeSize
} from './base.js';

/**
 * Bosphorus Imports Price List PDF scraper.
 *
 * Parses the Bosphorus dealer price list PDF (pdftotext -layout). The PDF has:
 *
 *   1. Budget Friendly table — item names with OLD PRICE / NEW PRICE columns
 *   2. Liquidation table — item names with JOB PACK / FULL PALLET / ENTIRE SERIES prices
 *   3. Porcelain/Ceramic series pages — series header, colors, sizes, finishes, prices, box info
 *   4. Natural Stone pages — stone name, tile/mosaic/liner tables with sizes as columns
 *   5. Paver pages — similar to porcelain but with coping/tread rows
 *
 * Budget items have strikethrough old prices shown as two values: "$5.40 $4.28/ sqft"
 * (we take the last/current price).
 *
 * Creates/matches products, SKUs, pricing, packaging, and attributes.
 */

const VENDOR_CODE = 'BOS';

const NOISE_PATTERNS = [
  /^WHOLESALE PRICE LIST/i,
  /^TYPE:\s*DEALER/i,
  /^EFFECTIVE DATE/i,
  /^1555 S\. State College/i,
  /^Phone:/i,
  /^www\.bosphorusimports/i,
  /^DISCLOSURES FOR FOB/i,
  /^Item & Pricing Disclosure/i,
  /^Receiving and Installation/i,
  /^Return Disclosure/i,
  /^-\s*(All prices|This price|Please ask|Natural MARBLE|It is the|Bosphorus Imports|No returns|Absolutely)/i,
  /^INDEX PAGE/i,
  /^Porcelain \/ Ceramic Tile$/,
  /^Liquidation Porcelain/,
  /^Natural Stone$/,
  /^Back To Index Page/i,
  /^\s*PAGE\s*$/,
  /^\s*[A-Z]-\d+\s*$/,   // Page numbers like "A-1", "J-2", "L-5"
  /^Note:/i,
  /^Rectified\s*Edge/i,
  /^Available in an?\s/i,
  /^\*\*Note:/i,
];

export async function run(pool, job, source) {
  const pdfPath = source.config && source.config.pdf_path;
  if (!pdfPath) throw new Error('No file configured. Set config.pdf_path to the Bosphorus price list PDF.');
  if (!fs.existsSync(pdfPath)) throw new Error(`File not found: ${pdfPath}`);

  await appendLog(pool, job.id, `Parsing Bosphorus price list PDF: ${pdfPath}`);

  const rawText = extractPdfText(pdfPath);
  await appendLog(pool, job.id, `Extracted ${rawText.length} characters from PDF`);

  // Auto-create vendor if not present
  let vendorId = source.vendor_id;
  if (!vendorId) {
    const vendorResult = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Bosphorus Imports', 'BOSPHORUS', 'https://www.bosphorusimports.com')
      ON CONFLICT (code) DO NOTHING RETURNING id
    `);
    if (vendorResult.rows.length) {
      vendorId = vendorResult.rows[0].id;
    } else {
      const existing = await pool.query("SELECT id FROM vendors WHERE code = 'BOSPHORUS'");
      vendorId = existing.rows[0].id;
    }
  }
  await appendLog(pool, job.id, `Using vendor_id: ${vendorId}`);

  const catMap = await loadCategoryMap(pool);

  // Parse the PDF
  const { series, budgetItems, liquidationItems, naturalStones } = parsePDF(rawText);

  const totalPorcelain = series.reduce((sum, s) =>
    sum + s.sizeBlocks.reduce((bs, b) => bs + b.items.length, 0), 0
  );
  const totalStone = naturalStones.reduce((sum, s) =>
    sum + s.tiles.length + s.mosaics.length + s.liners.length, 0
  );

  await appendLog(pool, job.id,
    `Parsed: ${series.length} porcelain/ceramic series (${totalPorcelain} items), ` +
    `${budgetItems.length} budget items, ${liquidationItems.length} liquidation items, ` +
    `${naturalStones.length} natural stones (${totalStone} items)`
  );

  let stats = {
    productsCreated: 0, productsUpdated: 0,
    skusCreated: 0, pricingSet: 0, packagingSet: 0, attributesSet: 0,
    errors: 0,
  };

  // ── Process porcelain/ceramic series ──
  for (let si = 0; si < series.length; si++) {
    const ser = series[si];
    const categoryId = resolveCategory(ser.material, ser.lookType, ser.name, catMap);

    for (const block of ser.sizeBlocks) {
      for (const item of block.items) {
        try {
          await createItemSku(pool, vendorId, ser, block, item, categoryId, stats);
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 30) {
            await addJobError(pool, job.id,
              `${ser.name} / ${item.finish} ${block.size}: ${err.message}`
            );
          }
        }
      }
    }

    if ((si + 1) % 20 === 0) {
      await appendLog(pool, job.id,
        `Series progress: ${si + 1}/${series.length}, Products: ${stats.productsCreated}, SKUs: ${stats.skusCreated}`,
        { products_found: si + 1, products_created: stats.productsCreated, skus_created: stats.skusCreated }
      );
    }
  }

  // ── Process budget items ──
  for (const item of budgetItems) {
    try {
      await createBudgetSku(pool, vendorId, item, catMap, stats);
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        await addJobError(pool, job.id, `Budget: ${item.name}: ${err.message}`);
      }
    }
  }

  // ── Process liquidation items ──
  for (const item of liquidationItems) {
    try {
      await createLiquidationSku(pool, vendorId, item, catMap, stats);
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        await addJobError(pool, job.id, `Liquidation: ${item.name}: ${err.message}`);
      }
    }
  }

  // ── Process natural stone ──
  for (const stone of naturalStones) {
    const categoryId = catMap['natural-stone'] || null;

    for (const tile of stone.tiles) {
      try {
        await createStoneSku(pool, vendorId, stone, tile, 'tile', categoryId, stats);
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 30) {
          await addJobError(pool, job.id, `Stone ${stone.name} / tile ${tile.size}: ${err.message}`);
        }
      }
    }

    for (const mosaic of stone.mosaics) {
      try {
        await createStoneSku(pool, vendorId, stone, mosaic, 'mosaic', categoryId, stats);
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 30) {
          await addJobError(pool, job.id, `Stone ${stone.name} / mosaic ${mosaic.size}: ${err.message}`);
        }
      }
    }

    for (const liner of stone.liners) {
      try {
        await createStoneSku(pool, vendorId, stone, liner, 'liner', categoryId, stats);
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 30) {
          await addJobError(pool, job.id, `Stone ${stone.name} / liner ${liner.size}: ${err.message}`);
        }
      }
    }
  }

  await appendLog(pool, job.id,
    `Complete. Products: ${stats.productsCreated} new / ${stats.productsUpdated} updated, ` +
    `SKUs: ${stats.skusCreated}, Pricing: ${stats.pricingSet}, Packaging: ${stats.packagingSet}, ` +
    `Attributes: ${stats.attributesSet}, Errors: ${stats.errors}`,
    {
      products_found: totalPorcelain + budgetItems.length + liquidationItems.length + totalStone,
      products_created: stats.productsCreated,
      products_updated: stats.productsUpdated,
      skus_created: stats.skusCreated,
    }
  );
}

// ─── Product / SKU creation ──────────────────────────────────────────────────

async function createItemSku(pool, vendorId, series, block, item, categoryId, stats) {
  const collection = titleCase(series.name);

  // For porcelain series, each color is a product; for single-finish series use collection as product
  const productName = series.colors.length > 0 ? collection : collection;

  const product = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: productName,
    collection,
    category_id: categoryId,
  });
  if (product.is_new) stats.productsCreated++;
  else stats.productsUpdated++;

  const sizeNorm = normSize(block.size);
  const isSqft = block.unit === 'sqft';
  const sellBy = isSqft ? 'sqft' : 'unit';
  const priceBasis = isSqft ? 'per_sqft' : 'per_unit';

  const finishLabel = item.finish || '';
  const variantName = [sizeNorm, finishLabel].filter(Boolean).join(', ') || sizeNorm;

  const skuParts = [VENDOR_CODE, slugify(series.name), slugify(sizeNorm)];
  if (item.finish) skuParts.push(slugify(item.finish));
  if (block.subType) skuParts.push(slugify(block.subType));
  const internalSku = skuParts.join('-');

  const sku = await upsertSku(pool, {
    product_id: product.id,
    vendor_sku: internalSku,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: sellBy,
    variant_type: block.subType || null,
  });
  if (sku.is_new) stats.skusCreated++;

  await upsertPricing(pool, sku.id, {
    cost: item.price,
    retail_price: 0,
    price_basis: priceBasis,
  });
  stats.pricingSet++;

  if (block.pcsPerBox > 0 || block.sqftPerBox > 0) {
    await upsertPackaging(pool, sku.id, {
      sqft_per_box: block.sqftPerBox || null,
      pieces_per_box: block.pcsPerBox || null,
    });
    stats.packagingSet++;
  }

  const attrs = [
    ['size', sizeNorm],
    ['finish', item.finish],
    ['material', series.material],
    ['country', series.origin],
  ];
  for (const [slug, val] of attrs) {
    if (val) {
      await upsertSkuAttribute(pool, sku.id, slug, val);
      stats.attributesSet++;
    }
  }
}

async function createBudgetSku(pool, vendorId, item, catMap, stats) {
  // Parse item name: "12x24 Gravel Matte" → size=12x24, collection=Gravel, finish=Matte
  const parsed = parseBudgetItemName(item.name);
  const collection = titleCase(parsed.collection);
  const categoryId = resolveCategory(null, item.lookType, collection, catMap);

  const product = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: collection,
    collection,
    category_id: categoryId,
  });
  if (product.is_new) stats.productsCreated++;
  else stats.productsUpdated++;

  const sizeNorm = normSize(parsed.size);
  const variantName = [sizeNorm, parsed.finish].filter(Boolean).join(', ');
  const internalSku = [VENDOR_CODE, slugify(collection), slugify(sizeNorm), slugify(parsed.finish)].filter(Boolean).join('-');

  const sku = await upsertSku(pool, {
    product_id: product.id,
    vendor_sku: internalSku,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: 'sqft',
  });
  if (sku.is_new) stats.skusCreated++;

  await upsertPricing(pool, sku.id, {
    cost: item.newPrice,
    retail_price: 0,
    price_basis: 'per_sqft',
  });
  stats.pricingSet++;
}

async function createLiquidationSku(pool, vendorId, item, catMap, stats) {
  const parsed = parseBudgetItemName(item.name);
  const collection = titleCase(parsed.collection);
  const categoryId = resolveCategory(null, item.lookType, collection, catMap);

  const product = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: collection,
    collection,
    category_id: categoryId,
  });
  if (product.is_new) stats.productsCreated++;
  else stats.productsUpdated++;

  const sizeNorm = normSize(parsed.size);
  const variantName = [sizeNorm, parsed.finish].filter(Boolean).join(', ');
  const internalSku = [VENDOR_CODE, slugify(collection), slugify(sizeNorm), slugify(parsed.finish)].filter(Boolean).join('-');

  const sku = await upsertSku(pool, {
    product_id: product.id,
    vendor_sku: internalSku,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: 'sqft',
  });
  if (sku.is_new) stats.skusCreated++;

  // Use job pack price as cost (most relevant for single-box purchase)
  await upsertPricing(pool, sku.id, {
    cost: item.jobPackPrice,
    retail_price: 0,
    price_basis: 'per_sqft',
  });
  stats.pricingSet++;
}

async function createStoneSku(pool, vendorId, stone, item, type, categoryId, stats) {
  const collection = titleCase(stone.name);
  const stoneType = stone.stoneType || 'Natural Stone';

  const product = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: collection,
    collection,
    category_id: categoryId,
  });
  if (product.is_new) stats.productsCreated++;
  else stats.productsUpdated++;

  const sizeNorm = normSize(item.size);
  const finishLabel = item.finish || '';
  const qualityLabel = item.quality || '';
  const variantParts = [sizeNorm, finishLabel, qualityLabel].filter(Boolean);
  const variantName = variantParts.join(', ');

  const skuParts = [VENDOR_CODE, slugify(stone.name), slugify(sizeNorm), slugify(finishLabel)];
  if (qualityLabel) skuParts.push(slugify(qualityLabel));
  if (type === 'mosaic') skuParts.push('mosaic');
  if (type === 'liner') skuParts.push('liner');
  const internalSku = skuParts.filter(Boolean).join('-');

  const isMosaic = type === 'mosaic';
  const isLiner = type === 'liner';
  const sellBy = (isMosaic || isLiner) ? 'unit' : 'sqft';
  const priceBasis = sellBy === 'sqft' ? 'per_sqft' : 'per_unit';

  const sku = await upsertSku(pool, {
    product_id: product.id,
    vendor_sku: internalSku,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: sellBy,
    variant_type: type,
  });
  if (sku.is_new) stats.skusCreated++;

  await upsertPricing(pool, sku.id, {
    cost: item.price,
    retail_price: 0,
    price_basis: priceBasis,
  });
  stats.pricingSet++;

  const attrs = [
    ['size', sizeNorm],
    ['finish', finishLabel],
    ['material', stoneType],
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
      encoding: 'utf-8',
    });
  } catch (err) {
    throw new Error(`pdftotext failed: ${err.message}. Is poppler-utils installed?`);
  }
}

// ─── PDF Parser ──────────────────────────────────────────────────────────────

function parsePDF(text) {
  const lines = text.split('\n');
  const series = [];
  const budgetItems = [];
  const liquidationItems = [];
  const naturalStones = [];

  let state = 'IDLE';
  let currentSeries = null;
  let currentStone = null;
  let currentOrigin = null;
  let isLiquidation = false;
  let budgetLookType = null;
  let liquidationLookType = null;

  // Column tracking for multi-size rows
  let sizeColumns = [];   // [{ size, charPos, subType, unit }]
  let pendingBoxInfo = []; // parsed box info per column

  // Natural stone state
  let stoneSection = null; // 'TILES' | 'MOSAICS' | 'LINERS' | 'VERSAILLES'
  let stoneSizeColumns = []; // [{ size, charPos }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;
    if (isNoiseLine(trimmed)) continue;

    // ── Detect origin (ITALIAN / SPAIN / SPANISH) ──
    if (/^\s{20,}(ITALIAN|SPAIN|SPANISH)\s*$/i.test(line)) {
      currentOrigin = trimmed.toUpperCase();
      if (currentOrigin === 'SPAIN') currentOrigin = 'SPANISH';
      continue;
    }

    // ── Budget Friendly section ──
    if (/^BUDGET FRIENDLY/i.test(trimmed)) {
      state = 'BUDGET';
      continue;
    }
    if (state === 'BUDGET') {
      if (/^LIQUIDATION/i.test(trimmed)) {
        state = 'LIQUIDATION_TABLE';
        continue;
      }
      // Look type headers in budget section
      if (/^(CONCRETE|STONE|MARBLE|PAVER|SUBWAY|WOOD|SOLID)\s+LOOK/i.test(trimmed)) {
        budgetLookType = trimmed;
        continue;
      }
      if (/^(OLD PRICE|Price Per|NEW PRICE)/i.test(trimmed)) continue;

      // Budget item row: "12x24 Gravel Matte   $3.83   $2.88"
      const budgetMatch = trimmed.match(/^(.+?)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)/);
      if (budgetMatch) {
        budgetItems.push({
          name: budgetMatch[1].trim(),
          oldPrice: parseFloat(budgetMatch[2]),
          newPrice: parseFloat(budgetMatch[3]),
          lookType: budgetLookType,
        });
      }
      continue;
    }

    // ── Liquidation table section (multi-column) ──
    if (state === 'LIQUIDATION_TABLE' || /^LIQUIDATION ITEM NAME/i.test(trimmed)) {
      state = 'LIQUIDATION_TABLE';

      if (/^LIQUIDATION ITEM|JOB PACK|PRICE|Price Per|\*ENTIRE/i.test(trimmed)) continue;

      // Look type headers
      if (/^(STONE|WOOD|SUBWAY|SOLID|CONCRETE|MARBLE)\s+LOOK/i.test(trimmed)) {
        liquidationLookType = trimmed;
        continue;
      }

      // Liquidation item row: "12x24 DuploStone   $1.79   $0.59   $0.30"
      const liqMatch = trimmed.match(/^(.+?)\s+\$([\d.]+)\s+\$([\d.]+)\s+\$([\d.]+)/);
      if (liqMatch) {
        liquidationItems.push({
          name: liqMatch[1].trim(),
          jobPackPrice: parseFloat(liqMatch[2]),
          palletPrice: parseFloat(liqMatch[3]),
          entireSeriesPrice: parseFloat(liqMatch[4]),
          lookType: liquidationLookType,
        });
        continue;
      }

      // End of liquidation table: when we hit a series header with no prices
      if (isSeriesHeader(trimmed) && !/\$/.test(trimmed)) {
        state = 'SERIES';
        // Fall through to series parsing below
      } else {
        continue;
      }
    }

    // ── Natural Stone detection ──
    if (/^(WHITE CARRARA|CALACATTA GOLD|TUNDRA GREY|PIETRA GREY|SILVER SHADOW|CREMA MARFIL|EMPERADOR|CAPPUCCINO|TURKISH CREAM|THASSOS WHITE)\s+(MARBLE)/i.test(trimmed) ||
        /^(NEPTUNE WHITE)\s+(LIME\s*STONE)/i.test(trimmed) ||
        /^(LIGHT|CLASSIC|NOCE|WALNUT|SILVER|GOLD|SCABOS|PHILADELPHIA)\s+TRAVERTINE/i.test(trimmed) ||
        /^(LIGHT\s*\/\s*CLASSIC)\s+TRAVERTINE/i.test(trimmed)) {
      // Save any previous stone
      if (currentStone) naturalStones.push(currentStone);

      const stoneType = detectStoneType(trimmed);
      currentStone = {
        name: trimmed.replace(/\s+/g, ' ').trim(),
        stoneType,
        tiles: [],
        mosaics: [],
        liners: [],
        versailles: [],
      };
      state = 'NATURAL_STONE';
      stoneSection = null;
      stoneSizeColumns = [];
      continue;
    }

    if (state === 'NATURAL_STONE' && currentStone) {
      if (/^NATURAL STONE\s*$/i.test(trimmed)) continue;

      // Section headers within natural stone
      if (/^\s*TI?ILES?\s*$/i.test(trimmed) || /^\s*TiILES\s*$/i.test(trimmed)) {
        stoneSection = 'TILES';
        continue;
      }
      if (/^\s*MOSAICS\s/i.test(trimmed) || /^\s*MOSAICS\s*$/i.test(trimmed)) {
        stoneSection = 'MOSAICS';
        // Parse mosaic size headers from same line or next
        stoneSizeColumns = parseStoneSizeHeader(line, trimmed);
        continue;
      }
      if (/^\s*LINERS?\s/i.test(trimmed) || /^\s*LINERS?\s*$/i.test(trimmed)) {
        stoneSection = 'LINERS';
        stoneSizeColumns = parseStoneSizeHeader(line, trimmed);
        continue;
      }
      if (/^Versailles\s+Pattern/i.test(trimmed)) {
        stoneSection = 'VERSAILLES';
        continue;
      }

      // Size header for TILES section (line with multiple size patterns)
      if (stoneSection === 'TILES' && isStoneSizeHeaderLine(trimmed)) {
        stoneSizeColumns = parseStoneSizeHeader(line, trimmed);
        continue;
      }

      // Mosaic/Liner size header continuation
      if ((stoneSection === 'MOSAICS' || stoneSection === 'LINERS') && isStoneSizeHeaderLine(trimmed)) {
        const moreCols = parseStoneSizeHeader(line, trimmed);
        if (moreCols.length > 0) stoneSizeColumns = moreCols;
        continue;
      }

      // Price rows in natural stone sections
      if (stoneSizeColumns.length > 0 && /\$[\d.]+/.test(trimmed)) {
        parseStoneRow(line, trimmed, currentStone, stoneSection, stoneSizeColumns);
        continue;
      }

      // Versailles pattern rows
      if (stoneSection === 'VERSAILLES' && /\$[\d.]+/.test(trimmed)) {
        const finish = extractStoneFinishLabel(trimmed);
        const prices = extractAllPrices(trimmed);
        if (finish && prices.length > 0) {
          // First price is Premium, second is Fantasy/Standard
          currentStone.tiles.push({
            size: 'Versailles',
            finish,
            quality: 'Premium',
            price: prices[0],
          });
          if (prices.length > 1 && prices[1] > 0) {
            currentStone.tiles.push({
              size: 'Versailles',
              finish,
              quality: 'Standard',
              price: prices[1],
            });
          }
        }
        continue;
      }

      // Detect new series or stone (exit natural stone mode)
      if (isSeriesHeader(trimmed) && !/MARBLE|TRAVERTINE|LIMESTONE|STONE/i.test(trimmed)) {
        if (currentStone) naturalStones.push(currentStone);
        currentStone = null;
        state = 'SERIES';
        // Fall through
      } else if (/^(WHITE CARRARA|CALACATTA GOLD|TUNDRA|PIETRA GREY|SILVER SHADOW|CREMA MARFIL|EMPERADOR|CAPPUCCINO|TURKISH|THASSOS|NEPTUNE|LIGHT|CLASSIC|NOCE|WALNUT|SILVER|GOLD|SCABOS|PHILADELPHIA)/i.test(trimmed) &&
                 /(MARBLE|TRAVERTINE|LIME\s*STONE)/i.test(trimmed)) {
        // New stone — handled at top of loop next iteration
        continue;
      } else {
        continue;
      }
    }

    // ── Liquidation marker ──
    if (/^\*LIQUIDATION\*$/i.test(trimmed)) {
      isLiquidation = true;
      continue;
    }

    // ── Series header detection ──
    if (state !== 'SERIES' && state !== 'IN_SERIES') {
      if (isSeriesHeader(trimmed)) {
        state = 'SERIES';
        // Fall through
      } else {
        continue;
      }
    }

    if (state === 'SERIES' || isSeriesHeader(trimmed)) {
      if (isSeriesHeader(trimmed)) {
        // Finalize current series: move sizeColumns to sizeBlocks
        if (currentSeries) {
          finalizeSeries(currentSeries, sizeColumns);
          series.push(currentSeries);
        }

        const name = trimmed.replace(/\s+SERIES\s*$/i, '').trim();
        currentSeries = {
          name,
          material: null,
          lookType: null,
          origin: currentOrigin,
          isLiquidation,
          colors: [],
          sizeBlocks: [],
        };
        sizeColumns = [];
        pendingBoxInfo = [];
        isLiquidation = false;
        state = 'IN_SERIES';
        continue;
      }
    }

    if (state === 'IN_SERIES' && currentSeries) {
      // ── Material / look type line ──
      if (/^(WOOD|MARBLE|CONCRETE|STONE|METAL|ENCAUSTIC|SUBWAY|HEXAGON|PICKET|SOLID|MOSAIC)\s+LOOK\s+(PORCELAIN|CERAMIC)/i.test(trimmed) ||
          /^(PORCELAIN|CERAMIC)\s+TILE/i.test(trimmed) ||
          /^PAVER\s+PORCELAIN/i.test(trimmed) ||
          /^MOSAIC\s+PORCELAIN/i.test(trimmed)) {
        currentSeries.lookType = trimmed;
        if (/PORCELAIN/i.test(trimmed)) currentSeries.material = 'Porcelain';
        else if (/CERAMIC/i.test(trimmed)) currentSeries.material = 'Ceramic';
        continue;
      }

      // ── Color labels (ALL-CAPS words before size/price section, often with vendor codes) ──
      // Colors appear as labels like "CLEAR (GC-01)" or just "WHITE"
      if (isColorLine(trimmed) && sizeColumns.length === 0) {
        const colorNames = extractColorNames(trimmed);
        for (const c of colorNames) {
          if (!currentSeries.colors.includes(c)) {
            currentSeries.colors.push(c);
          }
        }
        continue;
      }

      // ── Size header line ──
      if (isSizeHeaderLine(line, trimmed)) {
        // Finalize previous size columns before starting new ones
        if (sizeColumns.length > 0) {
          for (const col of sizeColumns) {
            if (col.items.length > 0 || col.pcsPerBox > 0 || col.sqftPerBox > 0) {
              currentSeries.sizeBlocks.push(col);
            }
          }
        }
        // Pass next lines for sub-type detection (Porcelain Mosaics, Bullnose, etc.)
        const nextLines = lines.slice(i + 1, i + 3).join(' ');
        sizeColumns = parseSizeColumns(line, trimmed, nextLines);
        pendingBoxInfo = [];
        continue;
      }

      // ── Sub-type labels on line after sizes (Porcelain Mosaics, Surface Bullnose, etc.) ──
      if (/Porcelain\s+(Mosaics?|Surface\s*Bullnose)/i.test(trimmed) ||
          /Ceramic\s+(Mosaics?|Surface\s*Bullnose|3D)/i.test(trimmed)) {
        // These describe the subtype for certain size columns
        continue;
      }

      // ── Porcelain/Ceramic Tiles label (ignore) ──
      if (/^(Porcelain|Ceramic)\s+Tiles?\s*(Rectified|Recti-)?/i.test(trimmed)) continue;
      if (/^Tiles\s+Rectified/i.test(trimmed)) continue;
      if (/^\s*Edge\s*$/i.test(trimmed)) continue;

      // ── Price rows (finish label + prices) ──
      if (/\$[\d.]+/.test(trimmed) || /^\d+\.\d{2}/.test(trimmed)) {
        const parsed = parsePriceRow(line, trimmed, sizeColumns);
        if (parsed) {
          for (const { colIdx, price, finish } of parsed) {
            if (colIdx < sizeColumns.length && price > 0) {
              sizeColumns[colIdx].items.push({
                finish,
                price,
              });
            }
          }
        }
        continue;
      }

      // ── Box Information ──
      if (/Box\s*Information|Box\s*Infor-/i.test(trimmed) || /^Box=/i.test(trimmed)) {
        parseBoxInfo(line, trimmed, sizeColumns, lines, i);
        continue;
      }

      // ── Continued box info lines (pcs, sqft without "Box Information" prefix) ──
      if (/Box\s*=\s*\d+\s*Pcs/i.test(trimmed) || /\d+[\d.]*\s*Sqft/i.test(trimmed)) {
        if (sizeColumns.length > 0) {
          parseBoxInfoLine(line, sizeColumns);
        }
        continue;
      }

      // ── Paver-specific rows ──
      if (/^Paver\s+(Pool\s+Coping|Drain\s+Coping|Coping|Stair)/i.test(trimmed)) {
        // Skip paver accessory rows
        continue;
      }

      // ── New series header → save current and start new ──
      if (isSeriesHeader(trimmed)) {
        if (currentSeries) {
          finalizeSeries(currentSeries, sizeColumns);
          series.push(currentSeries);
        }

        const name = trimmed.replace(/\s+SERIES\s*$/i, '').trim();
        currentSeries = {
          name,
          material: null,
          lookType: null,
          origin: currentOrigin,
          isLiquidation,
          colors: [],
          sizeBlocks: [],
        };
        sizeColumns = [];
        pendingBoxInfo = [];
        isLiquidation = false;
        continue;
      }
    }
  }

  // Save last items
  if (currentSeries) {
    finalizeSeries(currentSeries, sizeColumns);
    series.push(currentSeries);
  }
  if (currentStone) naturalStones.push(currentStone);

  return { series, budgetItems, liquidationItems, naturalStones };
}

/**
 * Move remaining sizeColumns into a series' sizeBlocks (deduplicating).
 */
function finalizeSeries(ser, sizeColumns) {
  if (!sizeColumns || sizeColumns.length === 0) return;
  const existingSizes = new Set(ser.sizeBlocks.map(b => b.size + '|' + (b.subType || '')));
  for (const col of sizeColumns) {
    const key = col.size + '|' + (col.subType || '');
    if (!existingSizes.has(key)) {
      ser.sizeBlocks.push(col);
      existingSizes.add(key);
    }
  }
}

// ─── Line classifiers ────────────────────────────────────────────────────────

function isNoiseLine(trimmed) {
  return NOISE_PATTERNS.some(p => p.test(trimmed));
}

function isSeriesHeader(trimmed) {
  // Series headers: ALL-CAPS, often end with "SERIES", no prices
  if (/\$/.test(trimmed)) return false;
  if (/\d+\.\d{2}/.test(trimmed)) return false;
  if (trimmed.length < 3 || trimmed.length > 80) return false;

  // Must match pattern like "GLOCAL SERIES" or "BLACK & WHITE SERIES" or "FORMA"
  if (/^[A-Z][A-Z\s&\-'\/\.]+\s+SERIES\s*$/i.test(trimmed)) return true;

  // Single-word series without "SERIES" suffix — only if it looks like a header
  // (starts at left margin, ALL-CAPS, not a known keyword)
  const knownNonHeaders = [
    'NATURAL STONE', 'PORCELAIN', 'CERAMIC', 'TILES', 'MOSAICS', 'LINERS',
    'BOX INFORMATION', 'RECTIFIED EDGE', 'ITALIAN', 'SPANISH', 'SPAIN',
    'BUDGET FRIENDLY', 'LIQUIDATION', 'INDEX PAGE', 'PAGE',
    'STONE LOOK', 'WOOD LOOK', 'MARBLE LOOK', 'CONCRETE LOOK',
    'METAL LOOK', 'SUBWAY LOOK', 'ENCAUSTIC LOOK', 'MOSAIC PORCELAIN',
    'PAVER PORCELAIN', 'HEXAGON LOOK', 'PICKET LOOK', 'SOLID LOOK',
  ];
  if (knownNonHeaders.some(k => trimmed.startsWith(k))) return false;

  return false; // Be conservative — require "SERIES" suffix
}

function isColorLine(trimmed) {
  // Color names: ALL-CAPS or Title Case, no prices, no size patterns
  if (/\$/.test(trimmed)) return false;
  if (/\d+\.\d{2}/.test(trimmed)) return false;
  if (/\d+"\s*x\s*\d+"/i.test(trimmed)) return false;
  if (/^(Porcelain|Ceramic|Tiles|Matte|Polished|Glossy|Box|Rectified)/i.test(trimmed)) return false;
  if (/^(Textured|Cross Cut|Vein Cut|Riga|Antique|Sketch|Flat|Deco|Opaque|Metallic)/i.test(trimmed)) return false;

  // Must be mostly letters
  const letters = trimmed.replace(/[^a-zA-Z]/g, '').length;
  return letters / trimmed.length > 0.5;
}

function extractColorNames(line) {
  // Split on 2+ spaces to get individual color names
  const parts = line.trim().split(/\s{3,}/).map(p => p.trim()).filter(Boolean);
  const colors = [];
  for (const p of parts) {
    // Strip vendor codes like "(GC-01)"
    const clean = p.replace(/\s*\([A-Z]{1,3}[\-\s]?\d+\)\s*/g, '').trim();
    if (clean && clean.length > 1 && !/^Note/i.test(clean)) {
      colors.push(titleCase(clean));
    }
  }
  return colors;
}

function isSizeHeaderLine(line, trimmed) {
  // Normalize curly/smart quotes to straight quotes for matching
  const norm = trimmed.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
  // Must contain size patterns like 12"x 24" or 12"x24" or 10 1/2" x 70 3/4"
  if (!/\d+(?:\s*\d+\/\d+)?[""]?\s*[xX]\s*\d+/i.test(norm) && !/\d+[xX]\d+/i.test(norm)) return false;
  // Must NOT have prices
  if (/\$[\d.]+/.test(norm)) return false;
  if (/^\d+\.\d{2}/.test(norm)) return false;
  // Must NOT be a color line with embedded size
  if (/^[A-Z]+\s+\d+[""]?x/i.test(norm) && !/^Tiles|^Porcelain|^Ceramic/i.test(norm)) return false;

  return true;
}

function isStoneSizeHeaderLine(trimmed) {
  // Natural stone size headers have multiple size patterns like 3"x6"  4"x4"  6"x6"  12"x12"
  const norm = trimmed.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
  const sizeMatches = norm.match(/\d+"?\s*[xX]\s*\d+[""]?/gi);
  return sizeMatches && sizeMatches.length >= 2 && !/\$/.test(norm);
}

// ─── Size column parsing ─────────────────────────────────────────────────────

function parseSizeColumns(line, trimmed, nextLines) {
  const columns = [];

  // Normalize curly/smart quotes to straight quotes
  const normLine = line.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
  const normNextLines = (nextLines || '').replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');

  // Find all size patterns with their positions in the normalized line
  const sizeRegex = /(\d+(?:\s+\d+\/\d+)?)\s*"?\s*[xX]\s*(\d+(?:\s+\d+\/\d+)?)\s*"?/gi;
  let match;
  while ((match = sizeRegex.exec(normLine)) !== null) {
    const rawSize = match[0];
    const charPos = match.index;

    // Determine sub-type from context after the size (check next line too for sub-types)
    const afterSize = normLine.slice(match.index + match[0].length, match.index + match[0].length + 50).trim();
    let subType = null;
    let unit = 'sqft';

    if (/Porcelain\s+Mosaics?/i.test(afterSize) || /Mosaic/i.test(afterSize)) {
      subType = 'Mosaic';
      unit = 'unit';
    } else if (/Surface\s*Bullnose/i.test(afterSize) || /Bullnose/i.test(afterSize)) {
      subType = 'Bullnose';
      unit = 'unit';
    } else if (/Subway/i.test(afterSize)) {
      subType = 'Subway';
    } else if (/Hexagon/i.test(afterSize)) {
      subType = 'Hexagon';
    } else if (/Rhomboid/i.test(afterSize)) {
      subType = 'Rhomboid';
    } else if (/Jolly/i.test(afterSize) || /Liner/i.test(afterSize) || /Pencil/i.test(afterSize)) {
      subType = 'Liner';
      unit = 'unit';
    } else if (/Deco/i.test(afterSize)) {
      subType = 'Deco';
    } else if (/Stave/i.test(afterSize) || /3D/i.test(afterSize)) {
      subType = 'Stave';
    } else if (/London|Chair\s*Rail|Quarter\s*Round|Torello/i.test(afterSize)) {
      subType = 'Trim';
      unit = 'unit';
    }

    // Normalize the size
    const sizeNorm = normalizeSize(rawSize);

    // Check if this is a small format (mosaic/trim)
    const dimMatch = sizeNorm.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
    if (dimMatch && !subType) {
      const d1 = parseFloat(dimMatch[1]);
      const d2 = parseFloat(dimMatch[2]);
      if (Math.max(d1, d2) <= 4) {
        unit = 'unit';
        subType = 'Mosaic';
      } else if (Math.min(d1, d2) <= 3 && Math.max(d1, d2) >= 12) {
        unit = 'unit';
        subType = 'Bullnose';
      }
    }

    columns.push({
      size: sizeNorm,
      rawSize,
      charPos,
      subType,
      unit,
      pcsPerBox: 0,
      sqftPerBox: 0,
      items: [],
    });
  }

  // Also add these as sizeBlocks to the current series
  // (done inline during parsing — the column objects ARE the blocks)

  return columns;
}

// ─── Price row parsing ───────────────────────────────────────────────────────

function parsePriceRow(line, trimmed, columns) {
  if (columns.length === 0) return null;

  // Extract finish label (text before first price)
  const firstDollar = line.indexOf('$');
  const firstDecimal = line.search(/\d+\.\d{2}/);
  const firstPricePos = firstDollar >= 0 ? firstDollar : firstDecimal;
  if (firstPricePos < 0) return null;

  const labelPart = line.slice(0, firstPricePos).trim();
  let finish = labelPart
    .replace(/^(Porcelain|Ceramic)\s+Tiles?\s*/i, '')
    .replace(/Rectified\s*Edge/i, '')
    .trim();

  // Clean up finish labels
  if (/^(Matte|Polished|Glossy|Honed|Textured|Cross\s*Cut|Vein\s*Cut|Riga|Antique|Sketch|Flat|Deco|Opaque|Metallic|Matte Peak|Glossy Peak)/i.test(finish)) {
    finish = titleCase(finish.replace(/\s*\/\s*Matte\s*Peak/i, ''));
  } else {
    finish = finish || null;
  }

  // Skip non-price rows that slipped through
  if (/^Box|^Paver|^N\/A$/i.test(finish)) return null;

  // Extract all prices from the line with their positions
  const results = [];
  const priceRegex = /\$?\s*([\d,]+\.\d{2})\s*(?:\/?\s*(?:sqft|ea\.?|sq\s*ft))?/gi;
  let priceMatch;
  const allPrices = [];

  while ((priceMatch = priceRegex.exec(line)) !== null) {
    allPrices.push({
      value: parseFloat(priceMatch[1].replace(/,/g, '')),
      pos: priceMatch.index,
      hasUnit: /\/(sqft|ea)/i.test(priceMatch[0]),
    });
  }

  if (allPrices.length === 0) return null;

  // Handle budget-style dual prices: "$5.40 $4.28/ sqft" — take the one with unit, or last
  // Group prices by column, then pick the current (last) price for each column
  const pricesByColumn = new Map();

  for (const p of allPrices) {
    // Find nearest column
    let bestCol = 0;
    let bestDist = Infinity;
    for (let ci = 0; ci < columns.length; ci++) {
      const dist = Math.abs(p.pos - columns[ci].charPos);
      if (dist < bestDist) {
        bestDist = dist;
        bestCol = ci;
      }
    }

    if (bestDist <= 60) {
      if (!pricesByColumn.has(bestCol)) pricesByColumn.set(bestCol, []);
      pricesByColumn.get(bestCol).push(p);
    }
  }

  // For each column, take the last price (current price) or the one with unit marker
  for (const [colIdx, prices] of pricesByColumn) {
    let bestPrice = prices[prices.length - 1]; // default to last
    const withUnit = prices.find(p => p.hasUnit);
    if (withUnit) bestPrice = withUnit;

    if (bestPrice.value > 0) {
      // Check unit from the price text
      const priceText = line.slice(bestPrice.pos, bestPrice.pos + 30);
      if (/\/\s*ea/i.test(priceText)) {
        columns[colIdx].unit = 'unit';
      }

      results.push({
        colIdx,
        price: bestPrice.value,
        finish,
      });
    }
  }

  return results.length > 0 ? results : null;
}

// ─── Box info parsing ────────────────────────────────────────────────────────

function parseBoxInfo(line, trimmed, columns, lines, lineIdx) {
  // Parse box info from current line and possibly next lines
  // Patterns: "Box=7 Pcs 13.56 Sqft   Box=2 Pcs 15.49 Sqft"
  //           "Box= 6 Pcs 15.49 Sqft"
  //           "Box= 3 Pcs / 7.75 Sqft"

  const fullText = trimmed.replace(/^Box\s*Information\s*/i, '').replace(/^Box\s*Infor-\s*/i, '');
  parseBoxInfoLine(line, columns);

  // Check next few lines for continuation
  for (let j = lineIdx + 1; j < Math.min(lineIdx + 4, lines.length); j++) {
    const nextTrimmed = lines[j].trim();
    if (!nextTrimmed) continue;
    if (/^Back\s+To/i.test(nextTrimmed)) break;
    if (/\$/.test(nextTrimmed)) break;
    if (isSeriesHeader(nextTrimmed)) break;

    if (/Box\s*=|Pcs|Sqft|pcs|sqft/i.test(nextTrimmed)) {
      parseBoxInfoLine(lines[j], columns);
    } else {
      break;
    }
  }

  // Now finalize: push columns as sizeBlocks
  // This is handled later when we process the series
}

function parseBoxInfoLine(line, columns) {
  // Extract all "Box=N Pcs" and "NN.NN Sqft" patterns with positions
  const boxMatches = [...line.matchAll(/Box\s*=\s*(\d+)\s*Pcs/gi)];
  const sqftMatches = [...line.matchAll(/([\d.]+)\s*Sqft/gi)];
  const pcsMatches = [...line.matchAll(/(\d+)\s*Pcs/gi)];

  // Try to match by position to columns
  for (const m of boxMatches) {
    const pcs = parseInt(m[1], 10);
    const pos = m.index;
    const nearest = findNearestColumn(columns, pos);
    if (nearest) nearest.pcsPerBox = pcs;
  }

  for (const m of sqftMatches) {
    const sqft = parseFloat(m[1]);
    const pos = m.index;
    const nearest = findNearestColumn(columns, pos);
    if (nearest && sqft > 0 && sqft < 200) nearest.sqftPerBox = sqft;
  }
}

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
  return bestDist <= 80 ? best : null;
}

// ─── Natural stone parsing ───────────────────────────────────────────────────

function parseStoneSizeHeader(line, trimmed) {
  const columns = [];

  // Normalize curly/smart quotes to straight quotes
  const normLine = line.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');

  // Pattern for sizes: 3"x6", 12"x12", 1"X1", Basket Weave, Pinwheel, etc.
  const sizeRegex = /(\d+(?:\/\d+)?"\s*[xX]\s*\d+(?:\/\d+)?"?(?:\s*(?:HEX|Herringbone|Hexagon|Chevron|Octagon))?)/gi;
  let match;

  while ((match = sizeRegex.exec(normLine)) !== null) {
    columns.push({
      size: normalizeSize(match[1]),
      charPos: match.index,
    });
  }

  // Also match named patterns that don't have standard size format
  const namedPatterns = [
    /Basket\s*Weave/gi,
    /Pinwheel/gi,
    /Ogee[-\s]*\d*/gi,
    /Crown\s*Molding/gi,
    /Base\s*Board/gi,
    /Rope\s*Liners?/gi,
    /Random\s*Strip/gi,
    /Penny\s*Round/gi,
    /Arabesque/gi,
    /Lantern/gi,
    /Rhomboid/gi,
    /Mini\s*Pattern/gi,
    /Mini\s*Brick/gi,
  ];

  for (const pattern of namedPatterns) {
    let namedMatch;
    while ((namedMatch = pattern.exec(line)) !== null) {
      const name = namedMatch[0].trim();
      if (!columns.find(c => Math.abs(c.charPos - namedMatch.index) < 5)) {
        columns.push({
          size: name,
          charPos: namedMatch.index,
        });
      }
    }
  }

  return columns.sort((a, b) => a.charPos - b.charPos);
}

function parseStoneRow(line, trimmed, stone, section, columns) {
  // Extract finish label (everything before first price)
  const firstPricePos = line.search(/\$[\d.]/);
  if (firstPricePos < 0) return;

  const labelPart = line.slice(0, firstPricePos).trim();
  const finish = labelPart
    .replace(/^\s*(Polished|Honed|Tumbled|Brushed|Filled|Unfilled|Split\s*Face|Round\s*Face|Calibrated)\s*/i, '')
    .trim();

  // Extract the main finish name
  let finishName = '';
  if (/Polished/i.test(labelPart)) finishName = 'Polished';
  else if (/Honed/i.test(labelPart)) finishName = 'Honed';
  else if (/Tumbled/i.test(labelPart)) finishName = 'Tumbled';
  else if (/Brushed/i.test(labelPart)) finishName = 'Brushed';
  else if (/Split\s*Face/i.test(labelPart)) finishName = 'Split Face';
  else if (/Round\s*Face/i.test(labelPart)) finishName = 'Round Face';
  else if (/Filled.*Honed.*Vein\s*Cut/i.test(labelPart)) finishName = 'Filled Honed Vein Cut';
  else if (/Filled.*Polished.*Vein\s*Cut/i.test(labelPart)) finishName = 'Filled Polished Vein Cut';
  else if (/Filled.*Honed.*Straight/i.test(labelPart)) finishName = 'Filled Honed';
  else if (/Filled.*Polished.*Straight/i.test(labelPart)) finishName = 'Filled Polished';
  else if (/Filled.*Honed.*Chiseled/i.test(labelPart)) finishName = 'Filled Honed Chiseled';
  else if (/Unfilled.*Brushed.*Chiseled/i.test(labelPart)) finishName = 'Unfilled Brushed Chiseled';
  else finishName = labelPart.replace(/\s*(Marble|Mosaics?|Tiles?|Liners?)\s*$/i, '').trim();

  // Extract quality label
  let quality = null;
  if (/Select/i.test(labelPart)) quality = 'Select';
  else if (/Standard/i.test(labelPart)) quality = 'Standard';

  // Extract all prices with positions
  const priceRegex = /\$([\d,.]+)/g;
  let priceMatch;
  const prices = [];
  while ((priceMatch = priceRegex.exec(line)) !== null) {
    const value = parseFloat(priceMatch[1].replace(/,/g, ''));
    if (value > 0 && !isNaN(value)) {
      prices.push({ value, pos: priceMatch.index });
    }
  }

  // Match each price to nearest column
  const target = section === 'MOSAICS' ? stone.mosaics :
                 section === 'LINERS' ? stone.liners :
                 stone.tiles;

  for (const p of prices) {
    let bestCol = null;
    let bestDist = Infinity;
    for (const col of columns) {
      const dist = Math.abs(p.pos - col.charPos);
      if (dist < bestDist) {
        bestDist = dist;
        bestCol = col;
      }
    }

    if (bestCol && bestDist <= 60) {
      target.push({
        size: bestCol.size,
        finish: finishName,
        quality,
        price: p.value,
      });
    }
  }
}

function extractStoneFinishLabel(trimmed) {
  const match = trimmed.match(/^(.+?)\s+\$/);
  return match ? match[1].trim() : null;
}

function extractAllPrices(text) {
  const prices = [];
  const regex = /\$([\d,.]+)/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val > 0) prices.push(val);
  }
  return prices;
}

function detectStoneType(name) {
  const upper = name.toUpperCase();
  if (upper.includes('MARBLE')) return 'Marble';
  if (upper.includes('TRAVERTINE')) return 'Travertine';
  if (upper.includes('LIMESTONE') || upper.includes('LIME STONE')) return 'Limestone';
  if (upper.includes('GRANITE')) return 'Granite';
  if (upper.includes('SLATE')) return 'Slate';
  if (upper.includes('QUARTZITE')) return 'Quartzite';
  return 'Natural Stone';
}

// ─── Budget item name parsing ────────────────────────────────────────────────

function parseBudgetItemName(name) {
  // "12x24 Gravel Matte" → { size: "12x24", collection: "Gravel", finish: "Matte" }
  // "24x48 Golden Pure Archi Polished" → { size: "24x48", collection: "Golden Pure Archi", finish: "Polished" }

  const sizeMatch = name.match(/^(\d+[xX]\d+)\s+/);
  const size = sizeMatch ? sizeMatch[1] : '';
  const rest = sizeMatch ? name.slice(sizeMatch[0].length) : name;

  // Known finishes that can appear at end
  const finishes = ['Matte', 'Polished', 'Glossy', 'Textured', 'R11', 'NAT', 'ST', 'Peak', 'Pure'];
  let finish = '';
  let collection = rest;

  // Check for finish suffix
  const words = rest.split(/\s+/);
  if (words.length > 1) {
    const lastWord = words[words.length - 1];
    // Check if last word is parenthetical like "(NAT)" or "(ST)"
    const parenMatch = lastWord.match(/^\(([^)]+)\)$/);
    if (parenMatch) {
      finish = parenMatch[1];
      collection = words.slice(0, -1).join(' ');
    } else if (finishes.some(f => f.toLowerCase() === lastWord.toLowerCase())) {
      finish = lastWord;
      collection = words.slice(0, -1).join(' ');
    }
  }

  return { size, collection: collection.trim(), finish: finish.trim() };
}

// ─── Category resolution ─────────────────────────────────────────────────────

async function loadCategoryMap(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const map = {};
  for (const row of result.rows) map[row.slug] = row.id;
  return map;
}

function resolveCategory(material, lookType, seriesName, catMap) {
  const combined = [(material || ''), (lookType || ''), (seriesName || '')].join(' ').toLowerCase();

  if (combined.includes('paver')) return catMap['pavers'] || null;
  if (combined.includes('mosaic')) return catMap['mosaic-tile'] || null;
  if (combined.includes('subway look') || combined.includes('picket look'))
    return catMap['backsplash-tile'] || null;
  if (combined.includes('marble') || combined.includes('travertine') ||
      combined.includes('limestone') || combined.includes('natural stone'))
    return catMap['natural-stone'] || null;
  if (combined.includes('ceramic'))
    return catMap['ceramic-tile'] || null;
  if (combined.includes('porcelain'))
    return catMap['porcelain-tile'] || null;

  return catMap['porcelain-tile'] || null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normSize(raw) {
  if (!raw) return '';
  return raw
    .replace(/["″'']/g, '')
    .replace(/\s*[xX×]\s*/g, 'x')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleCase(s) {
  if (!s) return s;
  const cleaned = s.replace(/[\s\u00A0]+/g, ' ').trim();
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
