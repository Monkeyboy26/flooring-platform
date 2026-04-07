import { execSync } from 'child_process';
import fs from 'fs';
import { upsertPricing, appendLog, addJobError } from './base.js';

/**
 * Bedrosians Price List PDF ingestion scraper.
 *
 * Parses the Bedrosians dealer price list PDF (exported from Excel) using
 * `pdftotext -layout`, extracts series/size/finish/unit/net price, then
 * matches to existing DB SKUs by collection + size + finish.
 *
 * This scraper does NOT create products — it only upserts pricing for
 * products already imported by the web scraper (bed.js).
 *
 * Expects source.config.pdf_path to point to the uploaded PDF file.
 */
export async function run(pool, job, source) {
  const pdfPath = source.config && source.config.pdf_path;
  if (!pdfPath) {
    throw new Error('No pdf_path configured. Upload a price list PDF first.');
  }

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  await appendLog(pool, job.id, `Parsing PDF: ${pdfPath}`);

  // Step 1: Extract text from PDF using pdftotext
  const rawText = extractPdfText(pdfPath);
  await appendLog(pool, job.id, `Extracted ${rawText.length} characters from PDF`);

  // Step 2: Parse the text into structured price entries
  const entries = parsePriceList(rawText);
  await appendLog(pool, job.id, `Parsed ${entries.length} price entries from PDF`);

  if (entries.length === 0) {
    throw new Error('No price entries found in PDF. Check format.');
  }

  // Log a few sample entries for verification
  for (const entry of entries.slice(0, 5)) {
    await appendLog(pool, job.id, `  Sample: ${entry.series} | ${entry.size} | ${entry.finish} | ${entry.unit} | $${entry.netPrice}`);
  }

  // Step 3: Load all Bedrosians SKUs with their size/finish attributes
  const vendorId = source.vendor_id;
  const skuData = await loadSkusWithAttributes(pool, vendorId);
  await appendLog(pool, job.id, `Loaded ${skuData.length} Bedrosians SKUs from DB`);

  // Step 4: Build lookup index for fast matching
  const skuIndex = buildSkuIndex(skuData);

  // Step 5: Match and upsert pricing
  let matched = 0;
  let unmatched = 0;
  let skusUpdated = 0;
  const unmatchedEntries = [];

  for (const entry of entries) {
    const normalizedSize = normalizeSize(entry.size);
    const priceBasis = entry.unit === 'PCS' ? 'per_unit' : 'per_sqft';

    // Build lookup key: series|size (with accent/diacritic normalization)
    const seriesKey = normalizeSeriesName(entry.series);
    const sizeKey = normalizedSize.toLowerCase();
    const finishKey = entry.finish.toLowerCase();

    // Try exact match: series + size + finish
    const lookupKey = `${seriesKey}|${sizeKey}`;
    const candidates = skuIndex.get(lookupKey) || [];

    let matchedSkus;
    if (finishKey) {
      // 1. Exact finish attribute match
      matchedSkus = candidates.filter(s =>
        s.finish && s.finish.toLowerCase() === finishKey
      );
      // 2. Finish in product name
      if (matchedSkus.length === 0) {
        matchedSkus = candidates.filter(s =>
          s.productName && s.productName.toLowerCase().includes(finishKey)
        );
      }
      // 3. If still no match, and candidates have no finish attribute at all,
      //    apply price to all candidates for this series+size (one price row → multiple colors)
      if (matchedSkus.length === 0) {
        const candidatesWithoutFinish = candidates.filter(s => !s.finish);
        if (candidatesWithoutFinish.length > 0) {
          matchedSkus = candidatesWithoutFinish;
        }
      }
    } else {
      // No finish in PDF row — match all candidates for this series+size
      matchedSkus = candidates;
    }

    if (matchedSkus.length > 0) {
      matched++;
      for (const sku of matchedSkus) {
        const bedCost = parseFloat(entry.netPrice) || 0;
        await upsertPricing(pool, sku.skuId, {
          cost: bedCost,
          retail_price: Math.round(bedCost * 2 * 100) / 100,
          price_basis: priceBasis
        });
        skusUpdated++;
      }
    } else {
      unmatched++;
      if (unmatchedEntries.length < 30) {
        unmatchedEntries.push(`${entry.series} | ${entry.size} | ${entry.finish} | $${entry.netPrice}`);
      }
    }
  }

  // Log unmatched entries for debugging
  if (unmatchedEntries.length > 0) {
    await appendLog(pool, job.id, `Unmatched PDF entries (first ${unmatchedEntries.length}):`);
    for (const u of unmatchedEntries) {
      await appendLog(pool, job.id, `  ${u}`);
    }
  }

  // Count SKUs that got no pricing
  const unpricedResult = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND (pr.cost IS NULL OR pr.cost = 0)
  `, [vendorId]);
  const unpricedSkus = parseInt(unpricedResult.rows[0].cnt, 10);

  await appendLog(pool, job.id,
    `Complete. PDF entries: ${entries.length}, Matched: ${matched}, Unmatched: ${unmatched}, SKUs updated: ${skusUpdated}, SKUs still unpriced: ${unpricedSkus}`,
    { products_found: entries.length, products_updated: skusUpdated }
  );
}

/**
 * Extract text from PDF using pdftotext with layout preservation.
 */
function extractPdfText(pdfPath) {
  try {
    return execSync(`pdftotext -layout "${pdfPath}" -`, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8'
    });
  } catch (err) {
    throw new Error(`pdftotext failed: ${err.message}. Is poppler-utils installed?`);
  }
}

/**
 * Parse the raw PDF text into structured price entries.
 *
 * The PDF is organized into series blocks. Each block has:
 * - Series name line: "Ikonite - NEW" or "Allora" or "360"
 * - Next line: "CATEGORY - IKONITE" or "CATEGORY - ALLORA"
 * - Size/description info, color table
 * - "STOCK" header line
 * - Price rows with wide spacing: Type  ItemCode  Size  Description  Unit  NetPrice
 * - "Packaging Information" section
 * - Footer with page number
 *
 * We extract: series name, size, finish (from description), unit, net price.
 */
function parsePriceList(text) {
  const entries = [];
  const lines = text.split('\n');

  let currentSeries = null;
  let inStockSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Detect series header: a line followed by "CATEGORY - XXX"
    // Pattern: "{SeriesName}" or "{SeriesName} - NEW" or "{SeriesName} - DISCONTINUED"
    // Next non-blank line starts with "CATEGORY - "
    if (/^CATEGORY\s*-\s*/i.test(trimmed)) {
      // Look backwards for the series name (the previous non-blank line)
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prev = lines[j].trim();
        if (!prev) continue;
        // Series name: strip " - NEW", " - DISCONTINUED", etc.
        const seriesMatch = prev.match(/^(.+?)(?:\s*-\s*(?:NEW|DISCONTINUED|LIMITED TO STOCK)\s*)?$/i);
        if (seriesMatch) {
          const candidate = seriesMatch[1].trim();
          // Skip if it looks like a page footer, header, or another CATEGORY line
          if (candidate.match(/^\d+\s+of\s+\d+/) || candidate.match(/^v\d+/) ||
              candidate.match(/^TABLE OF CONTENTS/i) || candidate.match(/^CATEGORY/i) ||
              candidate.match(/Price List$/i) || candidate.match(/^We strive/i) ||
              candidate.match(/^Legend:/i) || candidate.match(/^Applications/i)) {
            break;
          }
          currentSeries = candidate;
        }
        break;
      }
      inStockSection = false;
      continue;
    }

    // Detect STOCK header — price rows follow after this
    if (/^STOCK\s*$/.test(trimmed)) {
      inStockSection = true;
      continue;
    }

    // End of stock section markers
    if (/^Packaging Information/i.test(trimmed) || /^ANSI Testing/i.test(trimmed)) {
      inStockSection = false;
      continue;
    }

    // Page footer resets — but keep the current series (it may span pages)
    if (/^\d+\s+of\s+\d+/.test(trimmed) || /^We strive for accurate/i.test(trimmed)) {
      inStockSection = false;
      continue;
    }

    // Skip the "Type/Info  Item Code  Size  Description  Unit  Net Price" header row
    if (/^Type\/Info/i.test(trimmed)) continue;

    if (!currentSeries || !inStockSection) continue;

    // Parse price rows. The layout uses wide whitespace between columns.
    // Examples:
    //   "Field                          STPIKO●●●1224L                12x24                Field Tile - Lappato                S/F       4.49"
    //   "                               STPIKO●●●2448H                24x48                Field Tile - Honed                  S/F       4.01"
    //   "Trim                           STPIKO●●●424BNH               4x24                 Bullnose - Honed                   PCS       8.75"
    //
    // Strategy: match lines ending with  unit(S/F|PCS|LNF|SHT|SET)  price(d+.dd)
    // Then split remaining text by 2+ whitespace into columns to find size and description.
    const priceMatch = trimmed.match(/(S\/F|PCS|LNF|SHT|SET)\s+(\d+\.?\d{0,2})\s*$/i);
    if (!priceMatch) continue;

    const unit = priceMatch[1].toUpperCase();
    const netPrice = parseFloat(priceMatch[2]);
    if (netPrice <= 0 || isNaN(netPrice)) continue;

    // Remove the unit+price from the end, then split into columns
    const beforePrice = trimmed.slice(0, trimmed.length - priceMatch[0].length).trim();

    // Split by runs of 2+ whitespace to get columns
    const columns = beforePrice.split(/\s{2,}/).map(c => c.trim()).filter(c => c);

    // Find the size column: a dimension pattern like 12x24, 4x24, 8-1/2x10
    // Must contain 'x' or 'X' to be a real size (not just digits from item code)
    let size = null;
    let sizeIdx = -1;
    for (let c = 0; c < columns.length; c++) {
      if (/^\d[\dx.\-\/\s]*[xX×]\s*\d[\dx.\-\/]*$/i.test(columns[c])) {
        size = columns[c];
        sizeIdx = c;
        break;
      }
    }

    if (!size) continue;

    // Description is the column(s) after the size
    const description = columns.slice(sizeIdx + 1).join(' ').trim();
    if (!description) continue;

    const finish = extractFinish(description);

    entries.push({
      series: currentSeries,
      size,
      finish,
      description,
      unit,
      netPrice
    });
  }

  return entries;
}

/**
 * Extract finish from a description string.
 * e.g. "Field Tile - Lappato" → "Lappato"
 *      "Bullnose - Honed" → "Honed"
 *      "Field Tile - Matte Rectified" → "Matte"
 */
function extractFinish(description) {
  if (!description) return '';

  // Common finishes to look for
  const finishes = [
    'Lappato', 'Polished', 'Honed', 'Matte', 'Matt', 'Glossy', 'Gloss',
    'Satin', 'Textured', 'Structured', 'Natural', 'Tumbled', 'Brushed',
    'Chiseled', 'Flamed', 'Bush Hammered', 'Sandblasted', 'Antiqued',
    'Leather', 'Lapato', 'Rectified', 'Grip', 'Anti-Slip', 'Soft'
  ];

  // Try "- Finish" pattern first
  const dashMatch = description.match(/-\s*(.+)/);
  if (dashMatch) {
    const afterDash = dashMatch[1].trim();
    // Check if the text after dash contains a known finish
    for (const f of finishes) {
      if (afterDash.toLowerCase().includes(f.toLowerCase())) {
        return f;
      }
    }
    // Return the first word after dash as finish
    return afterDash.split(/\s+/)[0];
  }

  // Try to find a known finish anywhere in description
  for (const f of finishes) {
    if (description.toLowerCase().includes(f.toLowerCase())) {
      return f;
    }
  }

  return '';
}

/**
 * Normalize a size string for matching.
 * PDF: "12x24", "8-1/2x10", "1/2x8", "2.5x12"
 * DB:  '12" x 24"', '8.5" x 10"', '0.5" x 8"', '2.5" x 12"'
 * Output: "12x24", "8.5x10", "0.5x8", "2.5x12"
 */
function normalizeSize(size) {
  if (!size) return '';
  let s = size
    .replace(/["\s]/g, '')   // Remove quotes and spaces
    .replace(/[xX×]/g, 'x')  // Normalize x separator
    .toLowerCase();

  // Convert fractions to decimals: "8-1/2" → "8.5", "1/2" → "0.5"
  s = s.replace(/(\d+)-(\d+)\/(\d+)/g, (_, whole, num, den) => {
    return String(parseInt(whole) + parseInt(num) / parseInt(den));
  });
  s = s.replace(/(?<!\d)(\d+)\/(\d+)/g, (_, num, den) => {
    return String(parseInt(num) / parseInt(den));
  });

  return s;
}

/**
 * Load all SKUs for a vendor with their size and finish attributes.
 */
async function loadSkusWithAttributes(pool, vendorId) {
  const result = await pool.query(`
    SELECT
      s.id as sku_id,
      s.vendor_sku,
      p.name as product_name,
      p.collection,
      sa_size.value as size_value,
      sa_finish.value as finish_value
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sa_size ON sa_size.sku_id = s.id
      AND sa_size.attribute_id = (SELECT id FROM attributes WHERE slug = 'size' LIMIT 1)
    LEFT JOIN sku_attributes sa_finish ON sa_finish.sku_id = s.id
      AND sa_finish.attribute_id = (SELECT id FROM attributes WHERE slug = 'finish' LIMIT 1)
    WHERE p.vendor_id = $1
  `, [vendorId]);

  return result.rows.map(row => ({
    skuId: row.sku_id,
    vendorSku: row.vendor_sku,
    productName: row.product_name,
    collection: row.collection || '',
    size: row.size_value || '',
    finish: row.finish_value || ''
  }));
}

/**
 * Strip diacritics/accents and special characters for fuzzy matching.
 * "Cloé" → "cloe", "Le Café" → "le cafe", "90°" → "90"
 */
function normalizeSeriesName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Strip combining diacritics
    .replace(/[°'"]/g, '')             // Strip degree sign, quotes
    .toLowerCase()
    .trim();
}

/**
 * Build a lookup index for fast matching: Map<"series|normalizedSize", sku[]>
 */
function buildSkuIndex(skuData) {
  const index = new Map();

  for (const sku of skuData) {
    if (!sku.collection) continue;

    const seriesKey = normalizeSeriesName(sku.collection);
    const sizeKey = normalizeSize(sku.size);

    if (!sizeKey) continue;

    const key = `${seriesKey}|${sizeKey}`;
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(sku);
  }

  return index;
}
