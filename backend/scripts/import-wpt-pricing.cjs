#!/usr/bin/env node
/**
 * Import WPT Wholesale Pricing from PDF
 *
 * Parses the Western Pacific Tile wholesale price list PDF and applies
 * pricing + packaging data to existing WPT products in the database.
 *
 * Usage:
 *   node backend/scripts/import-wpt-pricing.cjs [path-to-pdf]
 *   node backend/scripts/import-wpt-pricing.cjs --dry-run "/path/to/WPT Q-2-2025.pdf"
 *
 * The PDF has two sections:
 *   1. Main WPT products (pages 1-16): no SKU codes, just product descriptions
 *      Columns: Product Description | Price | U/M | Pcs/Box | SF/Box | Bxs/Plt | SF/Pallet
 *
 *   2. AKUA Mosaics (pages 17+): has CAY- prefix SKU codes
 *      Columns: Product Description | SKU | Price | U/M | SIZE | SF/Sheet | Pcs/Bx | Lbs/bx
 *
 * pdf-parse v2 extracts styled/colored collection headers at the BOTTOM of each
 * page (after the data rows). This script handles that by splitting each page into
 * data sections and matching them to collection headers via text similarity.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Config ──────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Helper: page header / footer detection ──────────────────────────

const PAGE_HEADER_RE = [
  /^Wholesale Price List/i,
  /^Z\s*\d/i,
  /^Zone\s*\d/i,
  /^March\s+\d/i,
  /^EFFECTIVE\b/i,
  /^Prices subject/i,
  /^E-mail orders/i,
  /^westernpacifictile/i,
  /^Call\s*\(?714/i,
  /^Fax\s*\(?714/i,
  /^P\s+714/i,
  /^PHONE\b/i,
  /^FAX\s+\(?\d/i,
  /^TO PLACE AN ORDER/i,
  /^PLEASE ALLOW/i,
  /^WALL,?\s*FLOOR/i,
  /^WESTERN PACIFIC/i,
  /^WPT\s*WESTERN/i,
  /^Claims for damaged/i,
  /^product\.\s*If no claim/i,
  /^are satisfied/i,
  /^and size variation/i,
  /^installing\b/i,
  /^responsibility\b/i,
  /^on all returns/i,
  /^from a different/i,
  /^batch\.\s*Please/i,
  /^shade variation/i,
  /^will be a 25%/i,
  /^1245 N\. GROVE/i,
  /^Anaheim,?\s*CA/i,
  /^order\.\s*Please/i,
  /^\d+$/, // standalone page numbers
  /^by$/,  // standalone "by" on AKUA pages
  /^USAGE$/i,
  /^RECOMMENDATIONS$/i,
  /^Series Product Wall/i,
];

function isPageHeaderLine(line) {
  return PAGE_HEADER_RE.some(re => re.test(line));
}

function isColumnHeader(line) {
  return /^Product Description/i.test(line) || /^PRODUCT DESCRIPTION/i.test(line);
}

/**
 * Test if a line is a collection header (ALL CAPS, no price, appears at page bottom).
 * These are the styled colored-bar headers in the PDF.
 * Allows lowercase in parenthetical notes like "(continues)" and lowercase 'x' in sizes.
 */
function isCollectionHeaderLine(line) {
  if (!line || line.length < 2 || line.length > 100) return false;
  if (/\$/.test(line)) return false;
  if (/DISCONTINUED/i.test(line)) return false;
  if (isPageHeaderLine(line)) return false;
  if (isColumnHeader(line)) return false;
  if (/^(PENNY ROUNDS|MICRO CRYSTALS|PICKETS? RECYCLED|MIMI LEDGER|USAGE|RECOMMENDATIONS)\b/i.test(line)) return false;
  if (/^PLEASE REMOVE/i.test(line)) return false;
  // Strip parenthetical notes "(continues)", "(next page)" and lowercase 'x' between digits
  // before checking uppercase
  const stripped = line
    .replace(/\([^)]*\)/g, '')        // remove (continues), (next page), etc.
    .replace(/(\d)x(\d)/gi, '$1X$2')  // normalize 5x14 → 5X14
    .trim();
  if (stripped !== stripped.toUpperCase()) return false;
  // Must contain at least one alpha word of 2+ chars
  if (!/[A-Z]{2,}/.test(stripped)) return false;
  return true;
}

// ── Page splitting ──────────────────────────────────────────────────

/**
 * Split a page's lines into data sections and collection headers.
 * Returns { sections: string[][], headers: string[] }
 *
 * Data sections are separated by "Product Description ..." column header lines.
 * Collection headers are ALL CAPS lines that appear AFTER the last data row.
 */
function splitPage(lines) {
  // Find the last line that contains pricing data ($ sign or DISCONTINUED)
  let lastDataIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/\$[\d.]+/.test(l) || /DISCONTINUED/i.test(l) || /CALL FOR STOCK/i.test(l)) {
      lastDataIdx = i;
      break;
    }
  }

  if (lastDataIdx < 0) return { sections: [], headers: [] };

  // Everything up to and including lastDataIdx is the data area
  const dataArea = lines.slice(0, lastDataIdx + 1);
  const footerArea = lines.slice(lastDataIdx + 1);

  // Extract collection headers from footer
  const headers = [];
  for (const fl of footerArea) {
    const trimmed = fl.trim();
    if (isCollectionHeaderLine(trimmed)) {
      headers.push(trimmed);
    }
  }

  // Split data area into sections using column header lines as dividers
  const sections = [];
  let currentSection = [];

  for (const dl of dataArea) {
    if (isColumnHeader(dl)) {
      if (currentSection.length > 0) {
        sections.push(currentSection);
      }
      currentSection = [];
      continue;
    }
    // Skip page headers and empty lines within data area
    if (isPageHeaderLine(dl)) continue;
    // Skip sub-headers (e.g., "PENNY ROUNDS" within Terra Mosaics)
    if (/^(PENNY ROUNDS|MICRO CRYSTALS|PICKETS? RECYCLED|MIMI LEDGER)\b/i.test(dl)) continue;
    currentSection.push(dl);
  }
  if (currentSection.length > 0) {
    sections.push(currentSection);
  }

  return { sections, headers };
}

// ── Section-to-header matching ──────────────────────────────────────

/**
 * Normalize text for comparison: lowercase, strip non-alphanumeric, collapse spaces.
 */
function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the "description prefix" from the first data row of a section.
 * This is the text before the price ($), DISCONTINUED, or CAY- SKU code.
 */
function extractSectionPrefix(sectionRows) {
  for (const row of sectionRows) {
    const m = row.match(/^(.+?)(?:\s+\$[\d.]|\s+\d+\.\d+\s+SF|\s+DISCONTINUED|\s+CAY-|\s+CALL FOR)/i);
    if (m) return m[1].trim();
  }
  // Fallback: use first row entirely
  return sectionRows[0] || '';
}

/**
 * Score how well a section's data matches a collection header.
 * Returns 0-1 where 1 = perfect match.
 */
function matchScore(sectionPrefix, header) {
  const pNorm = normText(sectionPrefix);
  const hNorm = normText(header);

  if (!pNorm || !hNorm) return 0;

  const pWords = pNorm.split(' ');
  const hWords = hNorm.split(' ');

  // Remove common non-identifying words from header
  const skipWords = new Set([
    'x', 'polished', 'rectified', 'matte', 'glossy', 'wall', 'tiles', 'tile',
    'mosaics', 'mosaic', 'trim', 'pieces', 'por', 'new', 'packaging', 'sliced',
    'flat', 'pebbles', 'deco', 'blend', 'continues', 'glass', 'hex',
    'porcelain', 'ceramic', 'stone', 'natural',
  ]);
  const hSignificant = hWords.filter(w => !skipWords.has(w) && !/^\d+$/.test(w));
  if (hSignificant.length === 0) return 0;

  // Check how many significant header words appear in the description prefix
  let wordHits = 0;
  for (const hw of hSignificant) {
    if (pWords.some(pw => pw === hw || pw.startsWith(hw) || hw.startsWith(pw))) {
      wordHits++;
    }
  }

  let score = wordHits / hSignificant.length;

  // Bonus for size match (helps distinguish e.g. Caementum 12x24 vs 24x48)
  const hSize = header.match(/(\d+)\s*[xX]\s*(\d+)/);
  const pSize = sectionPrefix.match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (hSize && pSize && hSize[1] === pSize[1] && hSize[2] === pSize[2]) {
    score += 0.2;
  }

  return Math.min(1, score);
}

/**
 * Match data sections to collection headers for a page.
 * Returns array of collection header strings (one per section).
 */
function matchSections(sections, headers) {
  if (sections.length === 0) return [];
  if (headers.length === 0) {
    // No headers found — return 'Unknown' for each
    return sections.map(() => 'Unknown');
  }

  const result = new Array(sections.length).fill(null);
  const usedHeaders = new Set();

  // Build score matrix
  const scores = [];
  for (let si = 0; si < sections.length; si++) {
    const prefix = extractSectionPrefix(sections[si]);
    for (let hi = 0; hi < headers.length; hi++) {
      scores.push({ si, hi, score: matchScore(prefix, headers[hi]) });
    }
  }

  // Greedy best-match assignment
  scores.sort((a, b) => b.score - a.score);
  for (const { si, hi, score } of scores) {
    if (result[si] !== null) continue; // section already matched
    if (usedHeaders.has(hi)) continue; // header already used
    if (score < 0.3) continue; // too low
    result[si] = headers[hi];
    usedHeaders.add(hi);
  }

  // Assign remaining headers to remaining sections by elimination
  const unmatchedSections = [];
  const unmatchedHeaders = [];
  for (let i = 0; i < sections.length; i++) {
    if (result[i] === null) unmatchedSections.push(i);
  }
  for (let i = 0; i < headers.length; i++) {
    if (!usedHeaders.has(i)) unmatchedHeaders.push(i);
  }

  // Assign remaining in order (sections are roughly alphabetical, headers can be sorted)
  if (unmatchedSections.length > 0 && unmatchedHeaders.length > 0) {
    // Sort remaining headers alphabetically to match data section order
    unmatchedHeaders.sort((a, b) => headers[a].localeCompare(headers[b]));
    for (let j = 0; j < Math.min(unmatchedSections.length, unmatchedHeaders.length); j++) {
      result[unmatchedSections[j]] = headers[unmatchedHeaders[j]];
    }
  }

  // Any still unmatched get 'Unknown'
  return result.map(r => r || 'Unknown');
}

// ── Collection name cleaning ────────────────────────────────────────

function cleanCollectionName(raw) {
  let name = raw
    .replace(/\s*\(continues\)\s*/i, '')
    .replace(/\s*\(next page\)\s*/i, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')           // strip other parenthetical
    .replace(/^NEW ITEM\s+/i, '')             // "NEW ITEM SEA NEW ITEM" → "SEA NEW ITEM"
    .replace(/\s+NEW ITEM$/i, '')             // → "SEA"
    .replace(/\s*&\s*TRIM PIECES\s*/i, '')
    // Strip trailing size: "9 X 48", "9.25 X 47.25", "12X24", "24X48", "5X14" etc.
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+.*$/i, '')
    // Strip trailing type suffixes (may need multiple passes)
    .replace(/\s+(POLISHED|RECTIFIED|WALL|MOSAICS?|MATTE|GLOSSY|POR\.?|TILES?|PORCELAIN|CERAMIC|SHEET MOSAIC)\s*$/i, '')
    .replace(/\s+(POLISHED|RECTIFIED|WALL|MOSAICS?|MATTE|GLOSSY|POR\.?|TILES?|PORCELAIN|CERAMIC|SHEET MOSAIC)\s*$/i, '')
    .replace(/\s+(NEW PACKAGING)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Title case
  if (name === name.toUpperCase() && name.length > 1) {
    name = name
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\bDi\b/g, 'di')
      .replace(/\bDe\b/g, 'de')
      .replace(/\bdi Gre\b/g, 'di Gre')
      .replace(/\/(\w)/g, (m, c) => '/' + c.toUpperCase()); // "Leto/lelo" �� "Leto/Lelo"
  }

  return name;
}

// ── Data row parsing ────────────────────────────────────────────────

/**
 * Parse a single data row into a structured item.
 * Returns null if the line can't be parsed (non-data line).
 */
function parseDataRow(line, collection, isAkua) {
  // Check for DISCONTINUED
  if (/DISCONTINUED|CALL FOR STOCK/i.test(line)) {
    const discMatch = line.match(/^(.+?)\s+(DISCONTINUED|CALL FOR STOCK)/i);
    if (discMatch) {
      return {
        collection,
        description: discMatch[1].trim(),
        discontinued: true,
        isAkua,
      };
    }
    return null;
  }

  // AKUA format: Description | SKU (CAY-xxx) | Price | U/M | Size | SF/Sheet | Pcs/Bx | Lbs/bx
  if (isAkua) {
    // Clean backtick artifacts from SKU codes
    const cleanLine = line.replace(/`/g, '');

    // Standard AKUA row with full data (size may have spaces: "10.25 X 10.75")
    const akuaMatch = cleanLine.match(
      /^(.+?)\s+(CAY-[A-Z0-9]+)\s+\$?([\d.]+)\s+(sheet|SF|Each)\s+([\d.]+\s*[xX×]\s*[\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)/i
    );
    if (akuaMatch) {
      return {
        collection,
        description: akuaMatch[1].trim(),
        sku: akuaMatch[2].trim(),
        price: parseFloat(akuaMatch[3]),
        um: akuaMatch[4].trim(),
        size: akuaMatch[5].replace(/\s+/g, '').trim(),
        sfPerSheet: parseFloat(akuaMatch[6]),
        pcsPerBox: parseInt(akuaMatch[7]),
        lbsPerBox: parseInt(akuaMatch[8]),
        isAkua: true,
      };
    }

    // AKUA CALL / NO STOCK items (no pricing data)
    const akuaCallMatch = cleanLine.match(
      /^(.+?)\s+(CAY-[A-Z0-9]+)\s+(CALL|NO STOCK)\b/i
    );
    if (akuaCallMatch) {
      return {
        collection,
        description: akuaCallMatch[1].trim(),
        sku: akuaCallMatch[2].trim(),
        discontinued: akuaCallMatch[3].toUpperCase() === 'NO STOCK',
        callForPrice: akuaCallMatch[3].toUpperCase() === 'CALL',
        isAkua: true,
      };
    }
  }

  // Main WPT format: Description | Price | U/M | Pcs/Box | SF/Box | Bxs/Plt | SF/Pallet
  // Full match with all columns
  const mainMatch = line.match(
    /^(.+?)\s+\$?([\d.]+)\s+(SF|sheet|Each)\s+(\d+)\s+([\d.]+(?:[xX][\d.]+)?)\s+(\d+)\s+([\d.]+)/i
  );
  if (mainMatch) {
    const um = mainMatch[3].trim();
    const sfOrSize = mainMatch[5].trim();
    const item = {
      collection,
      description: mainMatch[1].trim(),
      price: parseFloat(mainMatch[2]),
      um,
      pcsPerBox: parseInt(mainMatch[4]),
      isAkua: false,
    };
    if (um.toLowerCase() === 'sheet') {
      item.sheetSize = sfOrSize;
    } else {
      item.sfPerBox = parseFloat(sfOrSize);
    }
    item.bxsPerPallet = parseInt(mainMatch[6]);
    item.sfPerPallet = parseFloat(mainMatch[7]);
    return item;
  }

  // Partial match: Description | Price | U/M | Pcs/Box | SF/Box (missing pallet info)
  const partialMatch = line.match(
    /^(.+?)\s+\$?([\d.]+)\s+(SF|sheet|Each)\s+(\d+)\s+([\d.]+(?:[xX][\d.]+)?)/i
  );
  if (partialMatch) {
    const um = partialMatch[3].trim();
    const sfOrSize = partialMatch[5].trim();
    const item = {
      collection,
      description: partialMatch[1].trim(),
      price: parseFloat(partialMatch[2]),
      um,
      pcsPerBox: parseInt(partialMatch[4]),
      isAkua: false,
    };
    if (um.toLowerCase() === 'sheet') {
      item.sheetSize = sfOrSize;
    } else {
      item.sfPerBox = parseFloat(sfOrSize);
    }
    return item;
  }

  // Minimal match: Description | Price | U/M | Pcs/Box (trim pieces, bullnose, etc.)
  const minMatch = line.match(/^(.+?)\s+\$?([\d.]+)\s+(SF|sheet|Each)\s+(\d+)/i);
  if (minMatch) {
    return {
      collection,
      description: minMatch[1].trim(),
      price: parseFloat(minMatch[2]),
      um: minMatch[3].trim(),
      pcsPerBox: parseInt(minMatch[4]),
      isAkua: false,
    };
  }

  // Very minimal: Description | Price | U/M (some bullnose items with no pcs/box)
  const tinyMatch = line.match(/^(.+?)\s+\$?([\d.]+)\s+(SF|sheet|Each)\s*$/i);
  if (tinyMatch) {
    return {
      collection,
      description: tinyMatch[1].trim(),
      price: parseFloat(tinyMatch[2]),
      um: tinyMatch[3].trim(),
      isAkua: false,
    };
  }

  // Couldn't parse — skip
  return null;
}

// ── Main PDF parser ─────────────────────────────────────────────────

/**
 * Parse the WPT price list PDF into structured line items.
 * Uses pdf-parse v2 API and processes per-page to handle collection
 * headers appearing at the bottom of extracted text.
 */
async function parsePdf(pdfPath) {
  const { PDFParse } = require('pdf-parse');
  const buffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse(new Uint8Array(buffer));
  await parser.load();
  const result = await parser.getText();

  const items = [];
  let isAkuaSection = false;

  console.log(`  PDF has ${result.total} pages`);

  for (const page of result.pages) {
    const rawLines = page.text.split('\n').map(l => l.trim()).filter(Boolean);

    // Detect AKUA section: "AKUA" is an image in the PDF and not extracted as text.
    // Detect by: CAY- SKU codes in data rows, or "Zone 1-2" / "Zone 1 & 2" headers.
    if (!isAkuaSection) {
      const hasCAY = rawLines.some(l => /CAY-[A-Z0-9]+/i.test(l));
      const hasZone12 = rawLines.some(l => /Zone\s*1[\s&-]+2/i.test(l));
      if (hasCAY || hasZone12) {
        isAkuaSection = true;
      }
    }

    // Skip non-data pages (cover pages, usage recommendations, etc.)
    const hasData = rawLines.some(l => /\$[\d.]+/.test(l) || /DISCONTINUED/i.test(l));
    if (!hasData) continue;

    // Split page into data sections and collection headers
    const { sections, headers } = splitPage(rawLines);
    if (sections.length === 0) continue;

    // Match sections to collection headers
    const collMap = matchSections(sections, headers);

    // Parse each section's data rows
    for (let i = 0; i < sections.length; i++) {
      const rawHeader = collMap[i];
      const collection = cleanCollectionName(rawHeader);

      for (const line of sections[i]) {
        const item = parseDataRow(line, collection, isAkuaSection);
        if (item) items.push(item);
      }
    }
  }

  return items;
}

// ── Database matching & import ──────────────────────────────────────

/**
 * Normalize a string for fuzzy comparison:
 * lowercase, strip accents, strip sizes, strip non-alphanumeric, collapse spaces.
 */
function normForMatch(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // é→e, etc.
    .toLowerCase()
    .replace(/\d+\.?\d*\s*["'″]\s*/g, '')               // strip 12", 24", etc.
    .replace(/\d+\.?\d*\s*[xX×]\s*\d+\.?\d*/g, '')      // strip 12x24, 9.25X47.25
    .replace(/\b\d+\s*[xX×]\s*\d+\b/g, '')              // strip standalone sizes
    .replace(/\b(polished|matte|rectified|glossy)\b/g, '') // strip finish types
    .replace(/\b(bullnose|quarter\s*round|profile)\b/g, '') // strip trim types
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Spelling variants / synonyms that should be treated as equivalent.
 */
const SPELLING_MAP = {
  relieve: 'relief',
  wenge: 'wengue',
  clarus: 'claurus',
  metro: 'metropolitan',
  staurario: 'statuario', // typo in PDF
};

function applySpellingMap(words) {
  return words.map(w => SPELLING_MAP[w] || w);
}

/**
 * Fuzzy match score between two strings.
 * Uses multiple metrics: Jaccard, overlap coefficient, substring containment.
 * Spelling normalization applied to handle variants.
 */
function fuzzyScore(a, b) {
  if (!a || !b) return 0;
  const na = normForMatch(a);
  const nb = normForMatch(b);
  if (na === nb) return 1;

  const wa = applySpellingMap(na.split(' ').filter(Boolean));
  const wb = applySpellingMap(nb.split(' ').filter(Boolean));
  if (!wa.length || !wb.length) return 0;

  const setA = new Set(wa);
  const setB = new Set(wb);
  let inter = [...setA].filter(w => setB.has(w)).length;

  // Count partial/prefix word matches as half-hits
  let partialHits = 0;
  for (const aw of setA) {
    if (aw.length < 3 || setB.has(aw)) continue;
    for (const bw of setB) {
      if (bw.length < 3) continue;
      if (aw.startsWith(bw) || bw.startsWith(aw)) {
        partialHits++;
        break;
      }
    }
  }

  const effectiveInter = inter + partialHits * 0.5;
  const union = new Set([...setA, ...setB]).size;

  // Jaccard similarity: |A ∩ B| / |A ∪ B|
  const jaccard = union > 0 ? effectiveInter / union : 0;

  // Overlap coefficient: |A ∩ B| / min(|A|, |B|)
  // Better for subset matches (e.g., "Archi Crema Herringbone" ⊂ "Archi Stone Crema Herringbone")
  // Only apply when smaller set has 2+ words — single-word overlap is too easy to trigger
  // (e.g., "WHITE" matches 1/1 of {"white"} ⊂ {"white","pencil"} = 100% overlap)
  const minSize = Math.min(setA.size, setB.size);
  const overlap = minSize > 0 ? effectiveInter / minSize : 0;
  const scaledOverlap = minSize >= 2 ? overlap * 0.92 : 0;

  // Substring containment bonus (scaled by length ratio)
  let substringScore = 0;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length >= nb.length ? na : nb;
    substringScore = 0.8 + 0.15 * (shorter.length / longer.length);
  }

  return Math.min(1, Math.max(jaccard, scaledOverlap, substringScore));
}

/**
 * Determine sell_by and price_basis from the PDF U/M field.
 */
function mapUnitOfMeasure(um) {
  const lower = (um || '').toLowerCase().trim();
  switch (lower) {
    case 'sf': return { sellBy: 'sqft', priceBasis: 'per_sqft' };
    case 'sheet': return { sellBy: 'unit', priceBasis: 'per_unit' };
    case 'each': return { sellBy: 'unit', priceBasis: 'per_unit' };
    default: return { sellBy: 'sqft', priceBasis: 'per_sqft' };
  }
}

/**
 * Build all candidate match strings from a PDF item.
 * Returns array of full-name candidates to try against DB product name.
 */
function buildPdfCandidates(item) {
  const coll = item.collection || '';
  const desc = item.description || '';

  // Strip sizes + "Base"/"All Colors" from description for matching
  const cleanDesc = desc
    .replace(/\b\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\b/g, '')
    .replace(/\bAll\s+Colors?\b/gi, '')
    .replace(/\bBase\b/gi, '')
    .replace(/\s+/g, ' ').trim();

  const candidates = new Set();

  // 1. collection + description (e.g., "Craft" + "Archi Stone Crema Brick" → "Craft Archi Stone Crema Brick")
  candidates.add(`${coll} ${cleanDesc}`);
  // 2. Just the description
  candidates.add(cleanDesc);
  // 3. Description might already include collection name (e.g., "Atelier 9x48 Wenge")
  //    → strip the collection prefix from description to get color part
  const descWithoutColl = cleanDesc.replace(new RegExp(`^${coll}\\s*`, 'i'), '').trim();
  if (descWithoutColl && descWithoutColl !== cleanDesc) {
    candidates.add(`${coll} ${descWithoutColl}`);
    candidates.add(descWithoutColl);
  }

  return [...candidates].filter(Boolean);
}

/**
 * Build all candidate match strings from a DB product row.
 * Returns array of name candidates to try against PDF items.
 * NOTE: Do NOT include bare collection name — it causes false positives
 * where any same-collection PDF item can match any DB product at 1.0.
 */
function buildDbCandidates(dbRow) {
  const name = dbRow.name || '';
  const coll = dbRow.collection || '';
  const candidates = new Set();

  // 1. Full product name (e.g., "Cotto Archi Stone Crema Brick")
  candidates.add(name);
  // 2. Name without collection prefix (e.g., "Archi Stone Crema Brick")
  const nameWithoutColl = name.replace(new RegExp(`^${coll}\\s*`, 'i'), '').trim();
  if (nameWithoutColl && nameWithoutColl !== name) {
    candidates.add(nameWithoutColl);
  }

  return [...candidates].filter(Boolean);
}

/**
 * Compute match score between a PDF item and a DB product.
 * Returns the best combined score using multiple strategies.
 * Returns 0 if the match doesn't meet minimum quality requirements.
 */
function computeMatchScore(item, dbRow, pdfCandidates, dbCands) {
  // For AKUA products, try exact SKU match
  if (item.sku && dbRow.vendor_sku && item.sku.toLowerCase() === dbRow.vendor_sku.toLowerCase()) {
    return 1.5; // above any fuzzy score
  }

  const collScore = fuzzyScore(item.collection, dbRow.collection);

  let bestNameScore = 0;
  for (const pc of pdfCandidates) {
    for (const dc of dbCands) {
      const s = fuzzyScore(pc, dc);
      if (s > bestNameScore) bestNameScore = s;
    }
  }

  // Guard: require SOME collection similarity (>= 0.25) unless name match is near-perfect (>= 0.92)
  // This prevents false cross-collection matches like "Urban > Gris" → "Drop Blue Pencil"
  if (collScore < 0.25 && bestNameScore < 0.92) return 0;

  // Multiple scoring strategies:
  // A. Traditional: weighted collection + name
  const scoreA = (collScore * 0.3) + (bestNameScore * 0.7);
  // B. Name-dominant: very high name match can overcome collection mismatch
  const scoreB = bestNameScore >= 0.85 ? bestNameScore : 0;
  // C. Collection-boosted: good collection + decent name
  const scoreC = collScore >= 0.7 ? (collScore * 0.2) + (bestNameScore * 0.8) : 0;

  // Add tiny collection-match bonus as tiebreaker
  return Math.max(scoreA, scoreB, scoreC) + collScore * 0.001;
}

async function importPricing(pool, items) {
  const vendorResult = await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR LOWER(name) LIKE '%wpt%' LIMIT 1`
  );
  if (!vendorResult.rows.length) {
    console.error('ERROR: WPT vendor not found in database. Run the scraper first.');
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;

  const dbProducts = await pool.query(`
    SELECT p.id AS product_id, p.name, p.collection,
           s.id AS sku_id, s.internal_sku, s.vendor_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Loaded ${dbProducts.rows.length} WPT SKUs from database`);

  // Pre-build candidate strings
  const dbCandidatesMap = new Map();
  for (const row of dbProducts.rows) {
    dbCandidatesMap.set(row.sku_id, buildDbCandidates(row));
  }

  // ── Phase 1: Compute all (pdfIdx, dbSkuId, score) triples ──
  const activeItems = items.filter(i => !i.discontinued && i.price);
  console.log(`Computing match scores for ${activeItems.length} active PDF items x ${dbProducts.rows.length} DB SKUs...`);

  const scorePairs = [];
  for (let pi = 0; pi < activeItems.length; pi++) {
    const item = activeItems[pi];
    const pdfCands = buildPdfCandidates(item);

    for (const dbRow of dbProducts.rows) {
      const score = computeMatchScore(item, dbRow, pdfCands, dbCandidatesMap.get(dbRow.sku_id));
      if (score >= 0.7) {
        scorePairs.push({ pi, skuId: dbRow.sku_id, dbRow, score });
      }
    }
  }

  // ── Phase 2: Greedy unique assignment ──
  // Sort by score descending. Each PDF item → at most one DB SKU, each DB SKU → at most one PDF item.
  scorePairs.sort((a, b) => b.score - a.score);

  const usedPdf = new Set();    // PDF items already assigned
  const usedDb = new Set();     // DB SKUs already assigned
  const assignments = [];       // { pi, item, dbRow, score }

  for (const { pi, skuId, dbRow, score } of scorePairs) {
    if (usedPdf.has(pi)) continue;
    if (usedDb.has(skuId)) continue;
    usedPdf.add(pi);
    usedDb.add(skuId);
    assignments.push({ pi, item: activeItems[pi], dbRow, score });
  }

  console.log(`Assigned ${assignments.length} unique matches`);

  // ── Phase 3: Apply pricing for matched pairs ──
  let pricingSet = 0;
  let packagingSet = 0;

  for (const { item, dbRow, score } of assignments) {
    const { sellBy, priceBasis } = mapUnitOfMeasure(item.um);

    await pool.query(
      `UPDATE skus SET sell_by = $1 WHERE id = $2 AND sell_by != $1`,
      [sellBy, dbRow.sku_id]
    );

    const retailPrice = +(item.price * 2).toFixed(2); // default 2x markup
    await pool.query(`
      INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (sku_id) DO UPDATE SET
        cost = EXCLUDED.cost,
        retail_price = EXCLUDED.retail_price,
        price_basis = EXCLUDED.price_basis
    `, [dbRow.sku_id, item.price, retailPrice, priceBasis]);
    pricingSet++;

    if (item.sfPerBox || item.pcsPerBox) {
      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (sku_id) DO UPDATE SET
          sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
          pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
          boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
          sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet)
      `, [
        dbRow.sku_id,
        item.sfPerBox || null,
        item.pcsPerBox || null,
        item.bxsPerPallet || null,
        item.sfPerPallet || null,
      ]);
      packagingSet++;
    }

    if (score < 0.85) {
      console.log(`  ~~ Fuzzy (${(score * 100).toFixed(0)}%): "${item.collection} > ${item.description}" -> "${dbRow.collection} > ${dbRow.name}" [$${item.price}]`);
    }
  }

  // ── Report unmatched ──
  const unmatchedPdf = activeItems.filter((_, i) => !usedPdf.has(i));
  const unmatchedDb = dbProducts.rows.filter(r => !usedDb.has(r.sku_id));

  if (unmatchedDb.length > 0) {
    console.log(`\n  DB products without PDF match (${unmatchedDb.length}):`);
    for (const r of unmatchedDb) {
      console.log(`    [${r.collection}] ${r.name}`);
    }
  }

  return {
    matched: assignments.length,
    unmatched: unmatchedPdf.length,
    pricingSet,
    packagingSet,
    unmatchedDbCount: unmatchedDb.length,
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const pdfPath = args[0];
  if (!pdfPath) {
    console.error('Usage: node import-wpt-pricing.cjs [--dry-run] <path-to-pdf>');
    console.error('  e.g. node backend/scripts/import-wpt-pricing.cjs "/path/to/WPT Q-2-2025.pdf"');
    process.exit(1);
  }

  if (!fs.existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`);
    process.exit(1);
  }

  console.log(`\n=== WPT Price List Import ===`);
  console.log(`PDF: ${path.basename(pdfPath)}`);
  if (DRY_RUN) console.log('MODE: DRY RUN (no database changes)');

  // Parse PDF
  console.log('\nParsing PDF...');
  const items = await parsePdf(pdfPath);
  console.log(`Parsed ${items.length} line items`);

  const active = items.filter(i => !i.discontinued);
  const discontinued = items.filter(i => i.discontinued);
  const akua = items.filter(i => i.isAkua);
  const main = items.filter(i => !i.isAkua);
  console.log(`  Main WPT: ${main.length} items (${main.filter(i => !i.discontinued).length} active)`);
  console.log(`  AKUA Mosaics: ${akua.length} items (${akua.filter(i => !i.discontinued).length} active)`);
  console.log(`  Total active: ${active.length}, Discontinued: ${discontinued.length}`);

  // Show collections found
  const collections = [...new Set(items.map(i => i.collection))];
  console.log(`\n  Collections found: ${collections.length}`);
  for (const c of collections.sort()) {
    const count = items.filter(i => i.collection === c).length;
    const activeCount = items.filter(i => i.collection === c && !i.discontinued).length;
    console.log(`    ${c}: ${count} items (${activeCount} active)`);
  }

  if (DRY_RUN) {
    // In dry-run mode, show sample items
    console.log('\n--- Sample items (first 10 active) ---');
    for (const item of active.slice(0, 10)) {
      const skuPart = item.sku ? ` [${item.sku}]` : '';
      const sfPart = item.sfPerBox ? ` ${item.sfPerBox}sf/box` : '';
      const palletPart = item.bxsPerPallet ? ` ${item.bxsPerPallet}bx/plt` : '';
      console.log(`  ${item.collection} > ${item.description}${skuPart}: $${item.price} ${item.um} ${item.pcsPerBox || '?'}pcs/box${sfPart}${palletPart}`);
    }
    console.log('\n=== Dry run complete ===');
    return;
  }

  // Import to database
  const pool = new Pool({ connectionString: DB_URL });
  try {
    console.log('\nImporting pricing...');
    const result = await importPricing(pool, items);

    console.log(`\n=== Import Complete ===`);
    console.log(`Matched: ${result.matched}`);
    console.log(`Unmatched: ${result.unmatched}`);
    console.log(`Pricing set: ${result.pricingSet}`);
    console.log(`Packaging set: ${result.packagingSet}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
