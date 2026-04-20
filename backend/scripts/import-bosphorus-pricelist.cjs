#!/usr/bin/env node
/**
 * Import Bosphorus Tier1 Wholesale Price List PDF into existing SKU pricing.
 *
 * Usage:
 *   node backend/scripts/import-bosphorus-pricelist.cjs /path/to/tier1.pdf [--dry-run]
 *
 * Reads the PDF with pdftotext, parses pricing tables, matches to existing
 * Bosphorus SKUs by collection + size + finish, and upserts pricing.
 */

const { execSync } = require('child_process');
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const pdfPath = process.argv.find(a => a.endsWith('.pdf'));

if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('Usage: node backend/scripts/import-bosphorus-pricelist.cjs /path/to/tier1.pdf [--dry-run]');
  process.exit(1);
}

// ─── PDF Parsing ─────────────────────────────────────────────────────────────

function extractText(path) {
  return execSync(`pdftotext -layout "${path}" -`, { maxBuffer: 50 * 1024 * 1024 }).toString();
}

/**
 * Normalize a size string to decimal format.
 * '4"x4"' → '4x4', '1/2"x8"' → '0.5x8', '3/4"x5"' → '0.75x5',
 * '2" 1/2"x10"' → '2.5x10', '2 1/2x10' → '2.5x10'
 */
function normalizeSize(raw) {
  if (!raw) return null;
  let s = raw.trim()
    .replace(/[""″'']/g, '')      // strip all quote marks
    .replace(/\s*x\s*/gi, 'x')    // normalize x separator
    .replace(/\s*×\s*/g, 'x');

  // Handle mixed fractions: "2 1/2" → 2.5, "10 1/2" → 10.5
  s = s.replace(/(\d+)\s+(\d+)\/(\d+)/g, (_, whole, n, d) =>
    (parseInt(whole) + parseInt(n) / parseInt(d)).toString()
  );

  // Handle simple fractions: "1/2" → 0.5, "3/4" → 0.75
  s = s.replace(/(\d+)\/(\d+)/g, (_, n, d) =>
    (parseInt(n) / parseInt(d)).toString()
  );

  s = s.replace(/\s+/g, '').toLowerCase();

  // Extract WxH
  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (m) return `${m[1]}x${m[2]}`;

  return null;
}

/**
 * Parse a price cell like "$5.67/sqft" or "$5.76/ piece" or "$14.00/ piece"
 * Returns { price, basis } or null
 */
function parsePrice(cell) {
  if (!cell || cell.trim() === '' || cell.trim() === 'N/A') return null;
  const m = cell.match(/\$\s*(\d+(?:\.\d+)?)\s*\/?\s*(sqft|piece|sq\.?\s*ft|each|pc|ea)/i);
  if (!m) return null;
  const price = parseFloat(m[1]);
  const basisRaw = m[2].toLowerCase();
  const basis = (basisRaw.includes('sqft') || basisRaw.includes('sq')) ? 'per_sqft' : 'per_unit';
  return { price, basis };
}

/**
 * Parse the PDF text into a list of collection pricing entries.
 * Each entry: { collection, sizes: [{ size, sizeLabel }], finishPrices: [{ finish, prices: [price_per_size] }] }
 */
function parsePDF(text) {
  const results = [];
  const lines = text.split('\n');

  let currentCollection = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect series header: "ARGILE SERIES", "BOOST STONE SERIES", etc.
    const seriesMatch = line.match(/^([A-Z][A-Z &\-.']+?)\s*SERIES\s*$/);
    if (seriesMatch) {
      currentCollection = seriesMatch[1].trim();
      // Normalize to title case
      currentCollection = currentCollection
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
      i++;
      continue;
    }

    // Detect pricing table start: line beginning with "Size"
    if (line.startsWith('Size') && currentCollection) {
      const rawLine = lines[i]; // Keep original spacing for column detection

      // Parse column positions from the Size header row
      const columns = parseColumnsFromSizeLine(rawLine);

      if (columns.length === 0) {
        i++;
        continue;
      }

      // Read finish/price rows until we hit "Box Information" or empty
      const entry = {
        collection: currentCollection,
        sizes: columns.map(c => ({ raw: c.raw, normalized: normalizeSize(c.sizeOnly), label: c.raw })),
        finishPrices: [],
      };

      i++;
      while (i < lines.length) {
        const row = lines[i];
        const trimmed = row.trim();

        if (!trimmed || trimmed.startsWith('Back To') || trimmed.match(/^\d+$/)) break;
        if (trimmed.startsWith('Box Information') || trimmed.startsWith('Box=')) {
          i++;
          // May continue to a second line of box info
          while (i < lines.length && lines[i].trim().match(/^(Sqft|N\/A|Box=)/)) i++;
          break;
        }

        // This should be a finish row: "Matte    $5.67/sqft    $5.76/ piece    $5.67/sqft"
        const finishName = extractFinishName(trimmed);
        if (finishName) {
          const prices = extractPricesFromRow(row, columns);
          entry.finishPrices.push({ finish: finishName, prices });
        }

        i++;
      }

      if (entry.finishPrices.length > 0) {
        results.push(entry);
      }
      continue;
    }

    i++;
  }

  return results;
}

/**
 * Parse column positions from the "Size" header line using whitespace gaps.
 * Returns array of { startCol, raw, sizeOnly }
 */
function parseColumnsFromSizeLine(line) {
  const columns = [];

  // Find "Size" label first — everything after it is size columns
  const sizeIdx = line.indexOf('Size');
  if (sizeIdx === -1) return [];

  // The first column label starts after "Size" + whitespace gap
  const afterSize = line.substring(sizeIdx + 4);

  // Split on 2+ spaces to get column values
  const parts = afterSize.split(/\s{2,}/).filter(s => s.trim());

  // Also track their positions in the original line for extracting prices
  let searchFrom = sizeIdx + 4;
  for (const part of parts) {
    const pos = line.indexOf(part.trim(), searchFrom);
    const raw = part.trim();
    // Extract just the size portion (remove descriptors like "Jolly Liner", "Surface bullnose", etc.)
    const sizeOnly = raw.replace(/\s*(Jolly\s*\w*|Quarter\s*Round\s*\w*|Surface\s*bullnose|Hexagon|Rhomboid|Subway|Mosaics?|Mosaic|London\s*Chair\s*Rail|Liner)\s*/gi, '').trim();
    columns.push({ startCol: pos, raw, sizeOnly });
    searchFrom = pos + raw.length;
  }

  return columns;
}

/**
 * Extract the finish name from the start of a pricing row.
 */
function extractFinishName(line) {
  const finishMatch = line.match(/^(Matte|Glossy|Polished|Honed|Satin|Natural|Textured|Structured|Slip-Resistant\s*R\d+|Grip|Lappato|Semi[- ]?Polished)/i);
  if (finishMatch) return finishMatch[1].trim();
  return null;
}

/**
 * Extract prices from a row using column positions.
 */
function extractPricesFromRow(line, columns) {
  const prices = [];

  for (let ci = 0; ci < columns.length; ci++) {
    const start = columns[ci].startCol;
    const end = ci + 1 < columns.length ? columns[ci + 1].startCol : line.length;
    const cell = line.substring(start, end).trim();
    prices.push(parsePrice(cell));
  }

  return prices;
}

// ─── DB Matching ─────────────────────────────────────────────────────────────

async function loadBosphorusSKUs() {
  const { rows } = await pool.query(`
    WITH bos_vendor AS (SELECT id FROM vendors WHERE name ILIKE '%bosphorus%' LIMIT 1)
    SELECT s.id as sku_id, s.variant_name, s.sell_by, s.variant_type,
           p.collection, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN bos_vendor bv ON p.vendor_id = bv.id
  `);
  return rows;
}

/**
 * Build a lookup map: collection_lower → size_norm → finish_lower → [skus]
 */
function buildSkuIndex(skus) {
  const index = {};

  for (const sku of skus) {
    const collKey = sku.collection.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!index[collKey]) index[collKey] = {};

    // Parse size and finish from variant_name: "3x24, Matte (Bullnose)" → size=3x24, finish=Matte
    const parts = sku.variant_name.match(/^([^,]+?)(?:,\s*(.+?))?(?:\s*\(.*\))?$/);
    if (!parts) continue;

    // Normalize fractional sizes: "1/2x8" → "0.5x8", "3/4x5" → "0.75x5"
    const rawSize = parts[1].trim();
    const sizeNorm = normalizeSize(rawSize) || rawSize.replace(/\s+/g, '').toLowerCase();
    const rawFinish = (parts[2] || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();

    if (!index[collKey][sizeNorm]) index[collKey][sizeNorm] = {};
    if (!index[collKey][sizeNorm][rawFinish]) index[collKey][sizeNorm][rawFinish] = [];
    index[collKey][sizeNorm][rawFinish].push(sku);

    // Also index without finish for single-finish collections
    if (!index[collKey][sizeNorm]['*']) index[collKey][sizeNorm]['*'] = [];
    index[collKey][sizeNorm]['*'].push(sku);
  }

  return index;
}

/**
 * Normalize collection name for matching.
 * PDF says "BOOST STONE" → DB has "Boost Stone"
 * PDF says "CERAMICA DI CARRARA" → DB has "Ceramica Di Carrara"
 */
function normalizeCollectionName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Bosphorus Tier1 Price List Import ===`);
  console.log(`PDF: ${pdfPath}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Extract and parse PDF
  console.log('Extracting text from PDF...');
  const text = extractText(pdfPath);
  console.log(`Extracted ${text.length} characters`);

  const entries = parsePDF(text);
  console.log(`Parsed ${entries.length} pricing tables from PDF\n`);

  // Load existing SKUs
  console.log('Loading existing Bosphorus SKUs...');
  const skus = await loadBosphorusSKUs();
  console.log(`Found ${skus.length} SKUs in database`);

  const index = buildSkuIndex(skus);
  const dbCollections = Object.keys(index);
  console.log(`Indexed ${dbCollections.length} collections\n`);

  // Match and update
  let stats = { matched: 0, unmatched: 0, pricingSet: 0, skipped: 0, collections: 0 };
  const unmatchedLog = [];

  for (const entry of entries) {
    const collKey = normalizeCollectionName(entry.collection);
    const collIndex = index[collKey];

    if (!collIndex) {
      // Try fuzzy match
      const fuzzy = dbCollections.find(k =>
        k.includes(collKey) || collKey.includes(k) ||
        k.replace(/\s+/g, '') === collKey.replace(/\s+/g, '')
      );
      if (fuzzy) {
        console.log(`  Collection "${entry.collection}" fuzzy-matched to "${fuzzy}"`);
        entry._collKey = fuzzy;
      } else {
        console.log(`  ✗ Collection "${entry.collection}" — no match in DB`);
        stats.unmatched++;
        unmatchedLog.push(`Collection: ${entry.collection}`);
        continue;
      }
    }

    const effectiveCollIndex = index[entry._collKey || collKey];
    if (!effectiveCollIndex) continue;
    stats.collections++;

    for (const fp of entry.finishPrices) {
      const finishLower = fp.finish.toLowerCase();

      for (let si = 0; si < entry.sizes.length; si++) {
        const sizeInfo = entry.sizes[si];
        const priceInfo = fp.prices[si];
        if (!priceInfo || !sizeInfo.normalized) continue;

        const sizeKey = sizeInfo.normalized.toLowerCase();
        const sizeIndex = effectiveCollIndex[sizeKey];

        if (!sizeIndex) {
          unmatchedLog.push(`  ${entry.collection} / ${sizeInfo.raw} / ${fp.finish} — size not found`);
          stats.unmatched++;
          continue;
        }

        // Try exact finish match first, then wildcard
        let matchedSkus = sizeIndex[finishLower] || [];

        // Try partial finish match (e.g., "Slip-Resistant R11" → "slip-resistant r11")
        if (matchedSkus.length === 0) {
          for (const [fkey, fskus] of Object.entries(sizeIndex)) {
            if (fkey === '*') continue;
            if (fkey.includes(finishLower) || finishLower.includes(fkey)) {
              matchedSkus = fskus;
              break;
            }
          }
        }

        // If still no match and only one finish exists for this size, use wildcard
        if (matchedSkus.length === 0) {
          const finishKeys = Object.keys(sizeIndex).filter(k => k !== '*');
          if (finishKeys.length === 1) {
            matchedSkus = sizeIndex[finishKeys[0]];
          } else if (finishKeys.length === 0) {
            matchedSkus = sizeIndex['*'] || [];
          }
        }

        if (matchedSkus.length === 0) {
          unmatchedLog.push(`  ${entry.collection} / ${sizeInfo.raw} / ${fp.finish} — no SKU match`);
          stats.unmatched++;
          continue;
        }

        // Apply pricing to all matched SKUs (same price for all colors)
        for (const sku of matchedSkus) {
          stats.matched++;
          if (!DRY_RUN) {
            await pool.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
              VALUES ($1, $2, $2, $3)
              ON CONFLICT (sku_id) DO UPDATE SET
                cost = COALESCE($2, pricing.cost),
                retail_price = COALESCE(NULLIF(pricing.retail_price, 0), $2),
                price_basis = COALESCE($3, pricing.price_basis)
            `, [sku.sku_id, priceInfo.price, priceInfo.basis]);
            stats.pricingSet++;
          } else {
            stats.pricingSet++;
          }
        }
      }
    }
  }

  // Report
  console.log(`\n=== Results ===`);
  console.log(`Collections matched: ${stats.collections}`);
  console.log(`SKU prices ${DRY_RUN ? 'would be ' : ''}set: ${stats.pricingSet}`);
  console.log(`SKU matches: ${stats.matched}`);
  console.log(`Unmatched entries: ${stats.unmatched}`);

  if (unmatchedLog.length > 0 && unmatchedLog.length <= 50) {
    console.log(`\nUnmatched details:`);
    for (const line of unmatchedLog) {
      console.log(line);
    }
  } else if (unmatchedLog.length > 50) {
    console.log(`\nFirst 30 unmatched:`);
    for (const line of unmatchedLog.slice(0, 30)) {
      console.log(line);
    }
    console.log(`  ... and ${unmatchedLog.length - 30} more`);
  }

  // Verify
  if (!DRY_RUN) {
    const { rows } = await pool.query(`
      WITH bos_vendor AS (SELECT id FROM vendors WHERE name ILIKE '%bosphorus%' LIMIT 1)
      SELECT COUNT(DISTINCT pr.sku_id) as priced_skus
      FROM pricing pr
      JOIN skus s ON s.id = pr.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN bos_vendor bv ON p.vendor_id = bv.id
    `);
    console.log(`\nTotal Bosphorus SKUs with pricing: ${rows[0].priced_skus}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
