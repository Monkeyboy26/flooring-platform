import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'arizona');

/**
 * Normalize an item description string into a lookup key.
 * Strips parenthesized notes (R11), (2CM), (SLIP-RESISTANT), commas, and excess whitespace.
 * Returns uppercase with size dimensions like "12X48".
 *
 * Examples:
 *   "AEQUA CASTOR,12X48"           → "AEQUA CASTOR 12X48"
 *   "AEQUA CASTOR (R11) 16X48 (2CM)" → "AEQUA CASTOR R11 16X48"
 *   "AEQUA CASTOR HEX 2-1/2 INCH,MOSAICO" → "AEQUA CASTOR HEX 2-1/2 MOSAICO"
 *   "AEQUA CASTOR,SBN 4X32"        → "AEQUA CASTOR SBN 4X32"
 */
/**
 * Parse slab sqft from dimensions embedded in item IDs like "(126X63)".
 * Returns sqft (length * width / 144) or null if no dimensions found.
 */
function parseSlabSqft(itemId) {
  const m = itemId.match(/(\d+)\s*X\s*(\d+)/i);
  if (!m) return null;
  return (parseInt(m[1]) * parseInt(m[2])) / 144;
}

/**
 * Normalize raw gauge/thickness strings to display values.
 * "2 CM" / "2CM" / "20MM" → "2CM"
 * "3 CM" / "3CM" / "1 1/4" / "30MM" → "3CM"
 * "1.5 CM" → "1.5CM"
 */
function normalizeGauge(gauge) {
  if (!gauge) return '';
  const g = String(gauge).toUpperCase().trim();
  if (/^2\s*CM$|^20\s*MM$/i.test(g)) return '2CM';
  if (/^3\s*CM$|^30\s*MM$|^1\s*1\/4$/i.test(g)) return '3CM';
  if (/^1\.5\s*CM$/i.test(g)) return '1.5CM';
  // Fallback: strip spaces
  return g.replace(/\s+/g, '');
}

/**
 * Remove thickness/gauge markers from a normalized item key to get a "stem"
 * for sibling matching across gauges.
 * "CLASSICO 3CM SLAB 126X63" → "CLASSICO SLAB 126X63"
 * "ZINC SLAB 1-1/4 126X63" → "ZINC SLAB 126X63"
 */
function stripGaugeFromKey(key) {
  return key
    .replace(/\b(?:2CM|3CM|1\.5CM|20MM|30MM)\b/gi, '')
    .replace(/\b1-1\/4\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeItemId(raw) {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .replace(/\(SLIP-RESISTANT\)/gi, '')
    .replace(/\(2CM\)/gi, '')
    .replace(/\(3CM\)/gi, '')
    .replace(/\(1\.5CM\)/gi, '')
    .replace(/\(\d+MM\)/gi, '')               // (9MM), (10MM) → strip thickness markers
    .replace(/\((\d+X\d+)\)/gi, '$1')       // (126X63) → 126X63
    .replace(/\((R11)\)/gi, 'R11')           // (R11) → R11
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a lookup key from WooCommerce variation attributes.
 * @param {string} collection - Product/collection name (e.g., "Aequa")
 * @param {string} colorSlug  - Color slug (e.g., "castor")
 * @param {string} sizeSlug   - Size slug (e.g., "8-x-32", "16-x-48-paver", "2-1-2-x-2-1-2-hex-mesh")
 * @param {string} finishSlug - Finish slug (e.g., "matte", "r11-finish")
 * @returns {string} Normalized lookup key
 */
export function buildLookupKey(collection, colorSlug, sizeSlug, finishSlug) {
  const parts = [];

  // Collection name
  if (collection) parts.push(collection.toUpperCase().trim());

  // Color
  if (colorSlug) {
    parts.push(colorSlug.toUpperCase().replace(/-/g, ' ').trim());
  }

  // Finish prefix (R11 goes before size in price list)
  const isR11 = finishSlug && /r11/i.test(finishSlug);
  if (isR11) parts.push('R11');

  // Size normalization: "8-x-32" → "8X32", "16-x-48-paver" → "16X48"
  if (sizeSlug) {
    let size = sizeSlug.toUpperCase();
    // Convert fraction slugs BEFORE stripping hyphens: "4-1-4" → "4-1/4", "9-3-4" → "9-3/4"
    size = size.replace(/\b(\d+)-(\d+)-(\d+)\b/g, '$1-$2/$3');
    // Protect fraction hyphens (e.g. "4-1/4") by converting to placeholder, strip remaining hyphens, restore
    size = size.replace(/(\d+)-(\d+\/\d+)/g, '$1\x00$2');
    size = size.replace(/-/g, ' ');
    size = size.replace(/\x00/g, '-');
    size = size.trim();
    // Remove PAVER suffix
    size = size.replace(/\bPAVER\b/g, '').trim();
    // Remove SCORED suffix (price list doesn't include it)
    size = size.replace(/\bSCORED\b/g, '').trim();
    // Remove TRAPEZOID suffix
    size = size.replace(/\bTRAPEZOID\b/g, '').trim();
    // Normalize dimensions: "8 X 32" → "8X32" (only between digits to preserve HEX, etc.)
    size = size.replace(/(\d)\s*X\s*(\d)/g, '$1X$2');
    // Handle hex with fraction: "2-3/8X2-3/8 HEX" → "HEX 2-3/8 IN"
    const hexFracMatch = size.match(/(\d+-\d+\/\d+)\s*X\s*\1\s*HEX/i);
    if (hexFracMatch) {
      size = `HEX ${hexFracMatch[1]} IN`;
    }
    // Handle hex mesh: "2 1 2 X 2 1 2 HEX MESH" → "HEX 2-1/2 MOSAICO"
    const hexMatch = size.match(/(\d+)\s+(\d+)\s+(\d+)\s*X\s*\1\s+\2\s+\3\s*HEX/i);
    if (hexMatch) {
      size = `HEX ${hexMatch[1]}-${hexMatch[2]}/${hexMatch[3]} MOSAICO`;
    }
    // "2X2 MOSAIC" → "MOSAICO 2X2" (price list uses MOSAICO prefix)
    const mosaicMatch = size.match(/^(\d+X\d+)\s*MOSAIC$/i);
    if (mosaicMatch) {
      size = `MOSAICO ${mosaicMatch[1]}`;
    }
    // "STRAIGHT STACK MESH 1X12" → "STACK" (price list just says "STACK")
    if (/STRAIGHT\s+STACK\s+MESH/i.test(size)) {
      size = 'STACK';
    }
    // "HEX16X18 MESH" / "HEX 16X18 MESH" → "HEXAGON" (price list format)
    if (/^HEX\s*\d+X\d+\s*MESH$/i.test(size)) {
      size = 'HEXAGON';
    }
    // "MESH SHEET" → "MESH" (price list uses just MESH for mesh-mounted mosaics)
    size = size.replace(/^MESH\s+SHEET$/i, 'MESH');
    // Remove trailing MESH for non-hex mosaics
    size = size.replace(/\s+MESH$/i, '').trim();
    // "LARGE CHEVRON" → "LG CHEVRON" (price list abbreviation)
    size = size.replace(/\bLARGE\s+CHEVRON\b/i, 'LG CHEVRON');
    if (size) parts.push(size);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Load tile price list and return a Map of normalized key → price entry.
 */
function loadTilePrices() {
  const filePath = path.join(DATA_DIR, 'tile-prices.xlsx');
  if (!fs.existsSync(filePath)) return new Map();

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Price List'];
  if (!ws) return new Map();

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const map = new Map();

  // Header is at row 7: Series, Item Status, Tile Type, Outer Limits, Item ID, Description, Unit, Sf/Pc, Pcs/Box, Sf/Box, Boxes/Pallet, Sf/Pallet, Net
  for (let i = 8; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[4]) continue; // Skip empty rows

    const series = row[0] || '';
    const itemStatus = row[1] || '';
    const tileType = row[2] || '';
    const itemId = String(row[4]).trim();
    const description = String(row[5] || '').trim();
    const unit = String(row[6] || '').toUpperCase();
    const sfPerPc = parseFloat(row[7]) || null;
    const pcsPerBox = parseInt(row[8]) || null;
    const sfPerBox = parseFloat(row[9]) || null;
    const boxesPerPallet = parseInt(row[10]) || null;
    const sfPerPallet = parseFloat(row[11]) || null;
    const netPrice = parseFloat(row[12]) || null;

    if (!netPrice) continue; // Skip rows without pricing

    const key = normalizeItemId(itemId);
    const entry = {
      series,
      itemId,
      description,
      itemStatus,
      tileType,
      unit,        // SF, EA, SHT, BX
      sfPerPc,
      pcsPerBox,
      sfPerBox,
      boxesPerPallet,
      sfPerPallet,
      netPrice,    // Dealer cost per unit
      source: 'tile',
    };

    map.set(key, entry);

    // Also index by item ID without the R11 prefix for fallback matching
    if (key.includes(' R11 ')) {
      const keyNoR11 = key.replace(/ R11 /, ' ');
      if (!map.has(keyNoR11)) map.set(keyNoR11 + '|R11', entry);
    }
  }

  return map;
}

/**
 * Load quartz slab price list.
 */
function loadQuartzPrices() {
  const filePath = path.join(DATA_DIR, 'quartz-prices.xlsx');
  if (!fs.existsSync(filePath)) return new Map();

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['D3'];
  if (!ws) return new Map();

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const map = new Map();

  // Header row 2: Item, Group, Note, Gauge, Size, SF/Slab, Status, Each, SF
  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0] || typeof row[0] !== 'string') continue;
    const itemId = row[0].trim();
    if (!itemId || /^(STANDARD|PREMIUM|SUPER PREMIUM|ULTRA)/i.test(itemId)) continue;

    const group = row[1] || '';
    const gauge = row[3] || '';
    const size = row[4] || '';
    const sfPerSlab = parseFloat(row[5]) || null;
    const status = row[6] || '';
    const eachPrice = parseFloat(String(row[7]).replace(/[↓↑\s$]/g, '')) || null;
    const sfPrice = parseFloat(String(row[8]).replace(/[↓↑\s$]/g, '')) || null;

    if (!sfPrice && !eachPrice) continue;

    const key = normalizeItemId(itemId);
    map.set(key, {
      itemId,
      group,
      gauge,
      size,
      sfPerSlab,
      status,
      eachPrice,
      sfPrice,
      netPrice: eachPrice || sfPrice,
      unit: eachPrice ? 'EA' : 'SF',
      source: 'quartz',
    });
  }

  return map;
}

/**
 * Load porcelain slab price list.
 */
function loadPorcelainSlabPrices() {
  const filePath = path.join(DATA_DIR, 'porcelain-slab-prices.xlsx');
  if (!fs.existsSync(filePath)) return new Map();

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['F3'];
  if (!ws) return new Map();

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const map = new Map();

  // Header row 2: Item, null, Description, Finish, Gauge, Book Match, SF/Slab, Status, Each, SF
  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0] || typeof row[0] !== 'string') continue;
    const itemId = row[0].trim();
    if (!itemId || itemId.startsWith('20')) continue; // Skip header-like rows

    const description = row[2] || '';
    const finish = row[3] || '';
    const gauge = row[4] || '';
    const sfPerSlab = parseFloat(row[6]) || null;
    const status = row[7] || '';
    const eachPrice = parseFloat(String(row[8]).replace(/[↓↑\s$]/g, '')) || null;
    const sfPrice = parseFloat(String(row[9]).replace(/[↓↑\s$]/g, '')) || null;

    if (!sfPrice && !eachPrice) continue;

    const key = normalizeItemId(itemId);
    map.set(key, {
      itemId,
      description,
      finish,
      gauge,
      sfPerSlab,
      status,
      eachPrice,
      sfPrice,
      netPrice: eachPrice || sfPrice,
      unit: eachPrice ? 'EA' : 'SF',
      source: 'porcelain-slab',
    });
  }

  return map;
}

/**
 * Load natural stone slab price list.
 */
function loadStonePrices() {
  const filePath = path.join(DATA_DIR, 'stone-slab-prices.xlsx');
  if (!fs.existsSync(filePath)) return new Map();

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['J3'];
  if (!ws) return new Map();

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const map = new Map();

  // Header row 3: Item, null, Type, Note, Gauge, Status, Price
  for (let i = 4; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0] || typeof row[0] !== 'string') continue;
    const itemId = row[0].trim();
    // Skip category headers (they don't have a price in col 6)
    const priceRaw = String(row[6] || '');
    const netPrice = parseFloat(priceRaw.replace(/[↓↑\s$]/g, '')) || null;
    if (!netPrice) continue;

    const stoneType = row[2] || '';
    const gauge = row[4] || '';
    const status = row[5] || '';

    const key = normalizeItemId(itemId);
    const sfPerSlab = parseSlabSqft(itemId);
    const eachPrice = sfPerSlab ? +(netPrice * sfPerSlab).toFixed(2) : null;
    map.set(key, {
      itemId,
      stoneType,
      gauge,
      status,
      sfPrice: netPrice,
      netPrice: eachPrice || netPrice,
      unit: eachPrice ? 'EA' : 'SF',
      sfPerSlab,
      source: 'stone-slab',
    });
  }

  return map;
}

/**
 * Load all Arizona Tile price lists and return a unified lookup.
 * Call once at scraper startup; the returned object is reused for all products.
 *
 * @returns {{ lookup: function(key: string): object|null, tileMap: Map, allMaps: Map }}
 */
export function loadAllPriceLists() {
  const tileMap = loadTilePrices();
  const quartzMap = loadQuartzPrices();
  const porcelainSlabMap = loadPorcelainSlabPrices();
  const stoneMap = loadStonePrices();

  // Merge all into one unified map (tile entries take priority for overlaps)
  const allMaps = new Map([...stoneMap, ...porcelainSlabMap, ...quartzMap, ...tileMap]);

  /**
   * Look up pricing for a given item.
   * Tries exact key first, then progressively looser matches.
   */
  function lookup(collection, colorSlug, sizeSlug, finishSlug) {
    const key = buildLookupKey(collection, colorSlug, sizeSlug, finishSlug);
    if (!key) return null;

    // Exact match
    if (allMaps.has(key)) return allMaps.get(key);

    // Try with INCH added (price list has "HEX 2-1/2 INCH" but WC slug doesn't)
    const keyWithInch = key.replace(/(HEX\s+[\d\-\/]+)/, '$1 INCH');
    if (keyWithInch !== key && allMaps.has(keyWithInch)) return allMaps.get(keyWithInch);

    // Try with finish inserted before size (e.g. "ARTE BONE 4X16" → "ARTE BONE GLOSSY 4X16")
    const finishName = (finishSlug && !/r11/i.test(finishSlug))
      ? finishSlug.toUpperCase().replace(/-/g, ' ').replace(/\s*FINISH$/, '').trim()
      : '';
    const FINISH_ABBR_LOOKUP = { POLISHED: 'POL', HONED: 'HON', MATTE: 'MAT' };
    const finishAbbr = FINISH_ABBR_LOOKUP[finishName] || '';
    if (finishName) {
      // Insert finish before the size dimension
      const keyWithFinish = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${finishName} $1`);
      if (allMaps.has(keyWithFinish)) return allMaps.get(keyWithFinish);
      // Also try finish before mosaic-style suffixes
      const keyWithFinishMosaico = key.replace(/(MOSAICO|STACK|HEXAGON)/, `${finishName} $1`);
      if (keyWithFinishMosaico !== key && allMaps.has(keyWithFinishMosaico)) return allMaps.get(keyWithFinishMosaico);
      // Insert finish before shape words (PICKET, RHOMBOID, LONG HEX)
      const keyWithFinishShape = key.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)\b/, `${finishName} $&`);
      if (keyWithFinishShape !== key && allMaps.has(keyWithFinishShape)) return allMaps.get(keyWithFinishShape);
      // Try with dimension-shape swap: "6X10 RHOMBOID" → "RHOMBOID 6X10" then insert finish
      const swapped = key.replace(/(\d+X\d+)\s+(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)/, '$2 $1');
      if (swapped !== key) {
        const keySwappedFinish = swapped.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)\b/, `${finishName} $&`);
        if (allMaps.has(keySwappedFinish)) return allMaps.get(keySwappedFinish);
      }
      // Insert finish before standalone HEX with fraction (hex mosaic: "HEX 2-3/8 IN")
      const keyWithFinishHex = key.replace(/\bHEX\s+(\d+-\d+\/\d+)/, `${finishName} HEX $1`);
      if (keyWithFinishHex !== key && allMaps.has(keyWithFinishHex)) return allMaps.get(keyWithFinishHex);
      // Try abbreviated finish (POLISHED → POL, HONED → HON)
      if (finishAbbr) {
        const keyAbbrDim = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${finishAbbr} $1`);
        if (keyAbbrDim !== key && allMaps.has(keyAbbrDim)) return allMaps.get(keyAbbrDim);
        const keyAbbrMosaico = key.replace(/(MOSAICO|STACK|HEXAGON)/, `${finishAbbr} $1`);
        if (keyAbbrMosaico !== key && allMaps.has(keyAbbrMosaico)) return allMaps.get(keyAbbrMosaico);
        const keyAbbrHex = key.replace(/\bHEX\s+(\d+-\d+\/\d+)/, `${finishAbbr} HEX $1`);
        if (keyAbbrHex !== key && allMaps.has(keyAbbrHex)) return allMaps.get(keyAbbrHex);
      }
    }

    // Compound finish: when finish contains multiple values (e.g. "Glossy (G), Matte (M)"),
    // parse individual finishes and try each one
    if (finishName) {
      const KNOWN_FINISH_WORDS = ['GLOSSY', 'MATTE', 'POLISHED', 'HONED', 'SATIN', 'NATURAL'];
      const parsedFinishes = KNOWN_FINISH_WORDS.filter(f => new RegExp('\\b' + f + '\\b').test(finishName));
      if (parsedFinishes.length > 1) {
        const FINISH_SHORT = { POLISHED: 'POL', HONED: 'HON' };
        for (const sf of parsedFinishes) {
          // Insert before dimension
          const k1 = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${sf} $1`);
          if (k1 !== key && allMaps.has(k1)) return allMaps.get(k1);
          // Insert before shape words (PICKET, RHOMBOID, etc.)
          const k2 = key.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON|HEXAGON|MOSAICO|STACK)\b/, `${sf} $&`);
          if (k2 !== key && allMaps.has(k2)) return allMaps.get(k2);
          // Try with dimension-shape swap: "6X10 RHOMBOID" → "RHOMBOID 6X10"
          const swapped = key.replace(/(\d+X\d+)\s+(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)/, '$2 $1');
          if (swapped !== key) {
            const k3 = swapped.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)\b/, `${sf} $&`);
            if (allMaps.has(k3)) return allMaps.get(k3);
          }
          // Abbreviation (POLISHED → POL)
          if (FINISH_SHORT[sf]) {
            const k4 = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${FINISH_SHORT[sf]} $1`);
            if (k4 !== key && allMaps.has(k4)) return allMaps.get(k4);
          }
        }
      }
    }

    // Deduplicated name: "NEGRO MARQUINA NEGRO MARQUINA 12X12" → "NEGRO MARQUINA 12X12"
    // Happens when collection === product name (natural stone simple-ish products mapped as variable)
    if (colorSlug) {
      const collUp = (collection || '').toUpperCase().trim();
      const colorUp = colorSlug.toUpperCase().replace(/-/g, ' ').trim();
      if (collUp === colorUp || collUp.startsWith(colorUp) || colorUp.startsWith(collUp)) {
        // Rebuild key without duplicating: use just the collection + size + finish
        const dedupKey = buildLookupKey(collection, null, sizeSlug, finishSlug);
        if (dedupKey && allMaps.has(dedupKey)) return allMaps.get(dedupKey);
        // Also try with finish before size dimension
        if (finishName && dedupKey) {
          const dedupFinish = dedupKey.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${finishName} $1`);
          if (allMaps.has(dedupFinish)) return allMaps.get(dedupFinish);
          // Finish before shape words (LG CHEVRON, PICKET, etc.)
          const dedupFinishShape = dedupKey.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON|HEXAGON|MOSAICO|STACK)\b/, `${finishName} $&`);
          if (dedupFinishShape !== dedupKey && allMaps.has(dedupFinishShape)) return allMaps.get(dedupFinishShape);
          // Try abbreviated finish before shape
          if (finishAbbr) {
            const dedupAbbrShape = dedupKey.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON|HEXAGON|MOSAICO|STACK)\b/, `${finishAbbr} $&`);
            if (dedupAbbrShape !== dedupKey && allMaps.has(dedupAbbrShape)) return allMaps.get(dedupAbbrShape);
          }
          // Dedup + VEIN CUT: try finish before "VEIN CUT" + thickness
          if (dedupKey.includes('VEIN CUT')) {
            const dedupVC = dedupKey.replace(/(.*?)VEIN CUT/, (_, before) =>
              before.trim() + ' ' + finishName + ' VEIN CUT'
            ).replace(/\s+/g, ' ').trim();
            if (allMaps.has(dedupVC)) return allMaps.get(dedupVC);
            const dedupVCThick = dedupVC.replace(/(\d+X\d+)(?!\S)/, '$1X3/8');
            if (dedupVCThick !== dedupVC && allMaps.has(dedupVCThick)) return allMaps.get(dedupVCThick);
          }
        }
      }
    }

    // Collection with hyphen: "GEO 2 THYME" → "GEO 2-THYME" (price list uses hyphen between collection and color)
    if (collection && colorSlug) {
      const collUp = (collection || '').toUpperCase().trim();
      const colorUp = colorSlug.toUpperCase().replace(/-/g, ' ').trim();
      const hyphenKey = key.replace(collUp + ' ' + colorUp, collUp + '-' + colorUp);
      if (hyphenKey !== key && allMaps.has(hyphenKey)) return allMaps.get(hyphenKey);
      // Also try with "HEX MESH" suffix (Geo 2 porcelain mosaics: "GEO 2-BISOU DAWN 13X13 HEX MESH")
      if (hyphenKey !== key) {
        const hyphenHexMesh = hyphenKey + ' HEX MESH';
        if (allMaps.has(hyphenHexMesh)) return allMaps.get(hyphenHexMesh);
      }
    }

    // Thickness suffix: natural stone tiles use "12X24X3/8" or "18X36X1/2" in price list
    // Try appending common thickness suffixes to the dimension
    {
      const thicknesses = ['X3/8', 'X1/2'];
      for (const t of thicknesses) {
        const keyThick = key.replace(/(\d+X\d+)(?!\S)/, `$1${t}`);
        if (keyThick !== key && allMaps.has(keyThick)) return allMaps.get(keyThick);
      }
      // Also try deduped key + thickness (Sahara: "SAHARA HONED 12X24X3/8")
      if (colorSlug) {
        const collUp = (collection || '').toUpperCase().trim();
        const colorUp = colorSlug.toUpperCase().replace(/-/g, ' ').trim();
        if (collUp === colorUp || collUp.startsWith(colorUp) || colorUp.startsWith(collUp)) {
          const dedupKey = buildLookupKey(collection, null, sizeSlug, finishSlug);
          if (dedupKey) {
            for (const t of thicknesses) {
              const dk = dedupKey.replace(/(\d+X\d+)(?!\S)/, `$1${t}`);
              if (dk !== dedupKey && allMaps.has(dk)) return allMaps.get(dk);
            }
            // Also try finish inserted before size + thickness
            if (finishName) {
              const dedupFinishThick = dedupKey.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${finishName} $1X3/8`);
              if (allMaps.has(dedupFinishThick)) return allMaps.get(dedupFinishThick);
              if (finishAbbr) {
                const dedupAbbrThick = dedupKey.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${finishAbbr} $1X3/8`);
                if (allMaps.has(dedupAbbrThick)) return allMaps.get(dedupAbbrThick);
              }
            }
          }
        }
      }
    }

    // "BLACK AND WHITE BW" → "B&W" (Cementine product naming)
    if (key.includes('BLACK AND WHITE BW')) {
      const bwKey = key
        .replace(/BLACK AND WHITE BW\s*/, 'B&W ')
        .replace(/\s+/g, ' ').trim();
      if (allMaps.has(bwKey)) return allMaps.get(bwKey);
    } else if (key.includes('BLACK AND WHITE')) {
      const bwKey = key
        .replace(/BLACK AND WHITE\s*/, 'B&W ')
        .replace(/\s+/g, ' ').trim();
      if (allMaps.has(bwKey)) return allMaps.get(bwKey);
    }

    // "SPLIT X" collection prefix: "SPLIT JADE 4X16" → "JADE SPLIT 4X16"
    // Price list puts material name first, then SPLIT as a format qualifier
    if (collection && /^split\b/i.test(collection)) {
      const baseColl = collection.replace(/^split\s+/i, '').trim();
      const splitKey = buildLookupKey(baseColl, colorSlug, sizeSlug, null);
      if (splitKey) {
        // Insert SPLIT after base collection name
        const baseUp = baseColl.toUpperCase().trim();
        const splitInserted = splitKey.replace(baseUp, baseUp + ' SPLIT');
        if (allMaps.has(splitInserted)) return allMaps.get(splitInserted);
        // Also try with 3D prefix: "JADE SPLIT 3D 4X16"
        const split3d = splitKey.replace(baseUp, baseUp + ' SPLIT 3D');
        if (allMaps.has(split3d)) return allMaps.get(split3d);
      }
    }

    // "VEIN CUT" products: finish goes BEFORE "VEIN CUT" in price list
    // "SILVER BEIGE VEIN CUT HONED 16X24" → "SILVER BEIGE HONED VEIN CUT 16X24X3/8"
    if (key.includes('VEIN CUT') && finishName) {
      const vcKey = key.replace(/(.*?)VEIN CUT\s*/, (_, before) => {
        return before.trim() + ' ' + finishName + ' VEIN CUT ';
      }).replace(/\s+/g, ' ').trim();
      if (allMaps.has(vcKey)) return allMaps.get(vcKey);
      // With thickness suffix
      const vcThick = vcKey.replace(/(\d+X\d+)(?!\S)/, '$1X3/8');
      if (vcThick !== vcKey && allMaps.has(vcThick)) return allMaps.get(vcThick);
      // With abbreviated finish
      if (finishAbbr) {
        const vcAbbr = key.replace(/(.*?)VEIN CUT\s*/, (_, before) => {
          return before.trim() + ' ' + finishAbbr + ' VEIN CUT ';
        }).replace(/\s+/g, ' ').trim();
        if (allMaps.has(vcAbbr)) return allMaps.get(vcAbbr);
        const vcAbbrThick = vcAbbr.replace(/(\d+X\d+)(?!\S)/, '$1X3/8');
        if (vcAbbrThick !== vcAbbr && allMaps.has(vcAbbrThick)) return allMaps.get(vcAbbrThick);
      }
    }

    // Try with RECT suffix (price list uses "RECT" for rectified edges)
    const keyRect = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, 'RECT $1');
    if (keyRect !== key && allMaps.has(keyRect)) return allMaps.get(keyRect);

    // When no finish provided, try inserting common finishes before size
    if (!finishName) {
      const COMMON_FINISHES = ['MATTE', 'GLOSSY', 'POLISHED', 'HONED', 'SATIN', 'NATURAL'];
      for (const f of COMMON_FINISHES) {
        const tryKey = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${f} $1`);
        if (tryKey !== key && allMaps.has(tryKey)) return allMaps.get(tryKey);
        // Also try with RECT
        const tryKeyRect = key.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${f} RECT $1`);
        if (tryKeyRect !== key && allMaps.has(tryKeyRect)) return allMaps.get(tryKeyRect);
        // Insert before shape words (PICKET, RHOMBOID, etc.) — handles cases
        // where finish goes between color and shape in price list
        const tryShape = key.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON|HEXAGON|MOSAICO|STACK)\b/, `${f} $&`);
        if (tryShape !== key && allMaps.has(tryShape)) return allMaps.get(tryShape);
        // Try with dimension-shape swap: "6X10 RHOMBOID" → "RHOMBOID 6X10"
        const swapped = key.replace(/(\d+X\d+)\s+(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)/, '$2 $1');
        if (swapped !== key) {
          const trySwapped = swapped.replace(/\b(PICKET|RHOMBOID|LONG\s+HEX|LG\s+CHEVRON)\b/, `${f} $&`);
          if (allMaps.has(trySwapped)) return allMaps.get(trySwapped);
        }
      }
    }

    // Strip extra suffixes from size that price list doesn't use (e.g. "MIXDECO", "SPLIT")
    const keyCleaned = key.replace(/\s+(MIXDECO|SPLIT|SCORED)\b/gi, '');
    if (keyCleaned !== key && allMaps.has(keyCleaned)) return allMaps.get(keyCleaned);

    // Subcollection overlap dedup: "CEMENTINE EVO" + "EVO 1" → key "CEMENTINE EVO EVO 1 8X8"
    // but price list has "CEMENTINE EVO 1 8X8" — remove the overlapping word(s)
    if (collection && colorSlug) {
      const collWords = collection.toUpperCase().trim().split(/\s+/);
      const colorWords = colorSlug.toUpperCase().replace(/-/g, ' ').trim().split(/\s+/);
      for (let n = Math.min(collWords.length - 1, colorWords.length); n >= 1; n--) {
        if (collWords.slice(-n).join(' ') === colorWords.slice(0, n).join(' ')) {
          const dedupColorSlug = colorWords.slice(n).join('-').toLowerCase() || null;
          const dedupKey = buildLookupKey(collection, dedupColorSlug, sizeSlug, finishSlug);
          if (dedupKey && allMaps.has(dedupKey)) return allMaps.get(dedupKey);
          break;
        }
      }
    }

    // Color === Size dedup: when both produce the same text, try with just one
    // Handles e.g. Digitalart "Blend Straight Stack" as both color and size
    if (colorSlug && sizeSlug) {
      const colorNorm = colorSlug.toUpperCase().replace(/-/g, ' ').trim();
      const sizeNorm = sizeSlug.toUpperCase().replace(/-/g, ' ').trim();
      if (colorNorm === sizeNorm) {
        const kNoSize = buildLookupKey(collection, colorSlug, null, finishSlug);
        if (kNoSize && allMaps.has(kNoSize)) return allMaps.get(kNoSize);
      }
    }

    // Collection name prefix in color: strip prefix and try variations
    // Handles e.g. Reverie + "Reverie Blanc" → try just "Blanc"
    if (collection && colorSlug) {
      const collUp = collection.toUpperCase().trim();
      const colorUp = colorSlug.toUpperCase().replace(/-/g, ' ').trim();
      if (colorUp.startsWith(collUp + ' ') && colorUp.length > collUp.length + 1) {
        const stripped = colorUp.slice(collUp.length + 1);
        const strippedSlug = stripped.toLowerCase().replace(/ /g, '-');

        // Direct match with stripped color
        const sk = buildLookupKey(collection, strippedSlug, sizeSlug, finishSlug);
        if (sk && allMaps.has(sk)) return allMaps.get(sk);

        // With finish inserted before dimension or MESH
        if (finishName && sk) {
          const skF1 = sk.replace(/(\d[\d\-\/]*X[\d\-\/]+)/, `${finishName} $1`);
          if (skF1 !== sk && allMaps.has(skF1)) return allMaps.get(skF1);
          const skF2 = sk.replace(/\b(MESH|MOSAICO|STACK|HEXAGON)\b/, `${finishName} $&`);
          if (skF2 !== sk && allMaps.has(skF2)) return allMaps.get(skF2);
        }

        // Slash between color words: "BLANC LUNA" → "BLANC/LUNA"
        // Price list uses "/" for multicolor mosaics (Petal, Prism, ZigZag)
        const words = stripped.split(' ');
        if (words.length >= 2) {
          for (let i = 1; i < words.length; i++) {
            const slashColor = words.slice(0, i).join(' ') + '/' + words.slice(i).join(' ');
            const slashSlug = slashColor.toLowerCase().replace(/ /g, '-');
            const skSlash = buildLookupKey(collection, slashSlug, sizeSlug, finishSlug);
            if (skSlash && allMaps.has(skSlash)) return allMaps.get(skSlash);
            if (finishName && skSlash) {
              const skSlashF = skSlash.replace(/\b(MESH|MOSAICO|STACK|HEXAGON)\b/, `${finishName} $&`);
              if (skSlashF !== skSlash && allMaps.has(skSlashF)) return allMaps.get(skSlashF);
            }
          }
        }

        // Numbered → DECOR N: Reverie "1" → "DECOR 1"
        if (/^\d+$/.test(stripped)) {
          const decorSlug = 'decor-' + stripped;
          const skDecor = buildLookupKey(collection, decorSlug, sizeSlug, finishSlug);
          if (skDecor && allMaps.has(skDecor)) return allMaps.get(skDecor);
        }
      }
    }

    // Collection-size overlap dedup: when color dropped and collection end = size start
    // Handles e.g. "Honey Tumbled Lyon" + size "Lyon Pattern" → "HONEY TUMBLED LYON PATTERN"
    if (collection && sizeSlug) {
      const collWords = collection.toUpperCase().trim().split(/\s+/);
      const sizeUp = sizeSlug.toUpperCase().replace(/-/g, ' ').trim();
      const sizeWords = sizeUp.split(/\s+/);
      for (let n = Math.min(collWords.length - 1, sizeWords.length); n >= 1; n--) {
        if (collWords.slice(-n).join(' ') === sizeWords.slice(0, n).join(' ')) {
          const trimmedSize = sizeWords.slice(n).join('-').toLowerCase() || null;
          const overlapKey = buildLookupKey(collection, null, trimmedSize, null);
          if (overlapKey && allMaps.has(overlapKey)) return allMaps.get(overlapKey);
          break;
        }
      }
    }

    // Marvel-style abbreviations: "BLACK ATLANTIS" → "BLK ATLANTIS", "MATTE" → "M"
    const COLOR_ABBR = { BLACK: 'BLK', CALACATTA: 'CAL', STATUARIO: 'STAT' };
    const FINISH_ABBR_SHORT = { MATTE: 'M', POLISHED: 'POL', HONED: 'HON' };
    if (collection && colorSlug) {
      const collUp = collection.toUpperCase().trim();
      let colorUp = colorSlug.toUpperCase().replace(/-/g, ' ').trim();
      let abbrColor = colorUp;
      for (const [long, short] of Object.entries(COLOR_ABBR)) {
        abbrColor = abbrColor.replace(new RegExp('\\b' + long + '\\b', 'g'), short);
      }
      let abbrFinish = finishName || '';
      for (const [long, short] of Object.entries(FINISH_ABBR_SHORT)) {
        if (abbrFinish === long) { abbrFinish = short; break; }
      }
      if (abbrColor !== colorUp || abbrFinish !== (finishName || '')) {
        let abbrKey = collUp + ' ' + abbrColor;
        if (abbrFinish) abbrKey += ' ' + abbrFinish;
        if (sizeSlug) {
          let sz = sizeSlug.toUpperCase().replace(/(\d+)-(\d+)-(\d+)/g, '$1-$2/$3');
          sz = sz.replace(/(\d+)-(\d+\/\d+)/g, '$1\x00$2').replace(/-/g, ' ').replace(/\x00/g, '-').trim();
          sz = sz.replace(/\bPAVER\b|\bSCORED\b|\bTRAPEZOID\b/g, '').trim();
          sz = sz.replace(/\s*X\s*/g, 'X');
          abbrKey += ' ' + sz;
        }
        abbrKey = abbrKey.replace(/\s+/g, ' ').trim();
        if (allMaps.has(abbrKey)) return allMaps.get(abbrKey);
      }
    }

    // Fuzzy: strip all spaces/hyphens and try matching against all keys
    const keyCompact = key.replace(/[\s\-\/]+/g, '');
    for (const [k, v] of allMaps) {
      if (k.replace(/[\s\-\/]+/g, '') === keyCompact) return v;
    }

    return null;
  }

  /**
   * Finish abbreviation map — price list uses short forms.
   * WC title "DT-Bianco Namibia Polished" → price list "DT-BIANCO NAMIBIA POL"
   */
  const FINISH_ABBR = {
    'POLISHED': 'POL',
    'MATTE': 'MAT',
    'HONED': 'HON',
    'SATIN': 'SATIN',
    'SOFT': 'SOFT',
  };

  /**
   * Look up pricing for a simple (non-variable) product by its title + parsed specs.
   * Simple products have no WC color/size/finish variation attributes, so we extract
   * hints from the product title, slug, and detail-page specs, then do prefix + fuzzy
   * matching against the price list.
   *
   * Returns the cheapest 2CM slab entry when multiple gauges exist, since the WC
   * simple product page represents the base product.
   *
   * @param {string} title - Product title (e.g., "Bianco Carrara", "DT-Bianco Namibia Polished")
   * @param {string} slug  - WC slug (e.g., "bianco-carrara", "dt-bianco-namibia-polished")
   * @param {object} specs - Parsed specs from detail page { finish, thickness, size, ... }
   * @returns {object|null} Price list entry or null
   */
  function lookupSimple(title, slug, specs) {
    if (!title) return null;

    const name = title.toUpperCase().trim();

    // ── 1) Exact match (unlikely but try) ──
    if (allMaps.has(name)) return allMaps.get(name);

    // ── 2) Derive search name with finish handling ──
    // Extract finish from title (e.g., "Bianco Carrara Honed" → finish = "HONED", stem = "BIANCO CARRARA")
    // or from slug suffix (e.g., "steel-grey-satin" → "SATIN")
    let searchName = name;
    let finishFromTitle = null;

    // Check if the title ends with a known finish
    for (const [longForm, abbr] of Object.entries(FINISH_ABBR)) {
      if (name.endsWith(' ' + longForm)) {
        finishFromTitle = longForm;
        break;
      }
    }

    // Also check slug for finish suffix
    if (!finishFromTitle && slug) {
      const slugUp = slug.toUpperCase().replace(/-/g, ' ');
      for (const longForm of Object.keys(FINISH_ABBR)) {
        if (slugUp.endsWith(' ' + longForm)) {
          finishFromTitle = longForm;
          break;
        }
      }
    }

    // ── 3) Try "NAME SLAB" pattern (stone + quartz slabs) ──
    const nameWithSlab = searchName + ' SLAB';
    if (allMaps.has(nameWithSlab)) return allMaps.get(nameWithSlab);

    // ── 4) For DT- products: abbreviate finish and try prefix match ──
    if (searchName.startsWith('DT-') || searchName.startsWith('DT ')) {
      const dtName = searchName.startsWith('DT ') ? 'DT-' + searchName.slice(3) : searchName;

      // Abbreviate finish in title: "DT-BIANCO NAMIBIA POLISHED" → "DT-BIANCO NAMIBIA POL"
      let dtSearch = dtName;
      for (const [longForm, abbr] of Object.entries(FINISH_ABBR)) {
        if (dtName.endsWith(' ' + longForm)) {
          dtSearch = dtName.slice(0, -(longForm.length)) + abbr;
          break;
        }
      }

      // Prefix match: find first entry starting with abbreviated name
      const candidates = [];
      for (const [k, v] of allMaps) {
        if (v.source === 'porcelain-slab' && k.startsWith(dtSearch + ' ')) {
          candidates.push(v);
        }
      }
      // Prefer "A" version (first book match)
      if (candidates.length > 0) {
        return candidates.find(c => c.itemId && /\bA\b/.test(c.itemId)) || candidates[0];
      }

      // Fuzzy DT- match: strip words down and try contains
      // Handles "CALACATTA MICHELANGELO" → "CAL MICHELANGELO", "MARVEL BLACK ATLANTIS" → "MARVEL BLK ATLANT"
      // Strip finish from search stem since we match finish separately
      let dtStem = dtSearch.replace(/^DT-/, '');
      for (const abbr of Object.values(FINISH_ABBR)) {
        if (dtStem.endsWith(' ' + abbr)) {
          dtStem = dtStem.slice(0, -(abbr.length + 1));
          break;
        }
      }
      const dtStemWords = dtStem.split(/\s+/);

      // Word match helper: returns true if words plausibly refer to the same term.
      // Handles prefix matches (CAL↔CALACATTA), truncation (ATLANT↔ATLANTIS),
      // and consonant abbreviation (BLK↔BLACK, SFT↔SOFT, D↔DI).
      function wordsMatch(plWord, searchWord) {
        if (searchWord.startsWith(plWord) || plWord.startsWith(searchWord)) return true;
        // Consonant abbreviation: check if plWord's letters appear in order in searchWord
        if (plWord.length >= 2 && searchWord.length > plWord.length) {
          let pi = 0;
          for (let si = 0; si < searchWord.length && pi < plWord.length; si++) {
            if (searchWord[si] === plWord[pi]) pi++;
          }
          if (pi === plWord.length) return true;
        }
        return false;
      }

      for (const [k, v] of allMaps) {
        if (v.source !== 'porcelain-slab' || !k.startsWith('DT-')) continue;
        const plStem = k.replace(/^DT-/, '').replace(/\s+(POL|SOFT|SFT|MAT)\b.*$/, '');
        const plWords = plStem.split(/\s+/);
        if (plWords.length > 0 && plWords.length <= dtStemWords.length &&
            plWords.every(pw => dtStemWords.some(sw => wordsMatch(pw, sw)))
        ) {
          // Found a fuzzy DT match — now find the right finish variant
          const finishAbbr = FINISH_ABBR[finishFromTitle] || null;
          if (finishAbbr) {
            // Try both standard and alt abbreviation (SOFT→SFT)
            const altAbbrs = finishAbbr === 'SOFT' ? ['SOFT', 'SFT'] : [finishAbbr];
            for (const fa of altAbbrs) {
              for (const [k2, v2] of allMaps) {
                if (v2.source === 'porcelain-slab' && k2.startsWith('DT-' + plStem + ' ' + fa)) {
                  return v2;
                }
              }
            }
          }
          // Return any match for this stem
          return v;
        }
      }
    }

    // ── 5) Prefix match across all slab maps ──
    // For stone: "BLACK PEARL SATIN" → matches "BLACK PEARL SATIN SLAB ($9.04)"
    // For quartz: "ZINC" → matches "ZINC SLAB 126X63 ($7.2)"
    // Prefer the base 2CM entry (no "1-1/4" in key) for the default price
    let prefixMatch = null;
    let prefixMatchThick = null;
    for (const [k, v] of allMaps) {
      if (v.source !== 'stone-slab' && v.source !== 'quartz') continue;
      if (k.startsWith(searchName + ' SLAB') || k.startsWith(searchName + ' ')) {
        if (!k.includes('1-1/4') && !k.includes('3CM') && !k.includes('1.5CM')) {
          if (!prefixMatch) prefixMatch = v;  // first = cheapest gauge
        } else {
          if (!prefixMatchThick) prefixMatchThick = v;
        }
      }
    }
    if (prefixMatch) return prefixMatch;
    if (prefixMatchThick) return prefixMatchThick;

    // ── 6) Name without finish suffix + SLAB ──
    // "BIANCO CARRARA HONED" → try "BIANCO CARRARA HONED SLAB", then "BIANCO CARRARA SLAB"
    if (finishFromTitle) {
      const nameNoFinish = searchName.slice(0, -(finishFromTitle.length + 1));
      const abbr = FINISH_ABBR[finishFromTitle] || finishFromTitle;

      // Try with abbreviated finish: "BIANCO CARRARA HON SLAB" (not actually used for stone, but just in case)
      // Try with full finish: "BIANCO CARRARA HONED SLAB"
      for (const variant of [searchName + ' SLAB', nameNoFinish + ' ' + abbr + ' SLAB', nameNoFinish + ' SLAB']) {
        if (allMaps.has(variant)) return allMaps.get(variant);
      }

      // Prefix match without finish
      for (const [k, v] of allMaps) {
        if (v.source !== 'stone-slab' && v.source !== 'quartz') continue;
        if (k.startsWith(nameNoFinish + ' SLAB') || k.startsWith(nameNoFinish + ' ')) {
          if (!k.includes('1-1/4') && !k.includes('3CM')) return v;
        }
      }
    }

    // ── 7) Tile prefix match for simple products ──
    // For non-slab tile products without size (e.g. "SPARK BARS IVORY"),
    // try matching with common finishes appended
    {
      const COMMON_FINISHES = ['MATTE', 'GLOSSY', 'POLISHED', 'HONED', 'NATURAL'];
      for (const [k, v] of allMaps) {
        if (v.source !== 'tile') continue;
        for (const f of COMMON_FINISHES) {
          if (k.startsWith(searchName + ' ' + f + ' ')) return v;
        }
      }
    }

    // ── 8) Fuzzy compact match (strip spaces/hyphens) ──
    const nameCompact = searchName.replace(/[\s\-\/]+/g, '');
    for (const [k, v] of allMaps) {
      const kStem = k.replace(/\s+SLAB.*$/, '').replace(/\s+\d+X\d+.*$/, '');
      if (kStem.replace(/[\s\-\/]+/g, '') === nameCompact) return v;
    }

    return null;
  }

  /**
   * Return all gauge/thickness entries for a simple (non-variable) slab product.
   * Calls lookupSimple() for the base match, then scans allMaps for sibling
   * entries at different gauges sharing the same stem key.
   *
   * For non-slab sources (tile), returns a single-element array.
   *
   * Each entry includes a `normalizedGauge` field (e.g. "2CM", "3CM").
   *
   * @param {string} title - Product title
   * @param {string} slug  - WC slug
   * @param {object} specs - Parsed specs from detail page
   * @returns {Array<object>} Array of price list entries sorted by gauge (thinnest first)
   */
  function lookupSimpleAllGauges(title, slug, specs) {
    const baseEntry = lookupSimple(title, slug, specs);
    if (!baseEntry) return [];

    // Only slab sources can have multiple gauges
    const SLAB_SOURCES = new Set(['quartz', 'stone-slab', 'porcelain-slab']);
    if (!SLAB_SOURCES.has(baseEntry.source)) {
      return [{ ...baseEntry, normalizedGauge: normalizeGauge(baseEntry.gauge) || '' }];
    }

    // Compute stem from the base entry's item ID
    const baseKey = normalizeItemId(baseEntry.itemId);
    const baseStem = stripGaugeFromKey(baseKey);

    // Collect all entries with matching stem from the same source
    const found = new Map(); // normalizedGauge → entry
    for (const [k, v] of allMaps) {
      if (v.source !== baseEntry.source) continue;
      const entryStem = stripGaugeFromKey(k);
      if (entryStem === baseStem) {
        const ng = normalizeGauge(v.gauge);
        if (!found.has(ng)) {
          found.set(ng, { ...v, normalizedGauge: ng });
        }
      }
    }

    // Ensure the base entry is included (in case stem matching missed it)
    const baseGauge = normalizeGauge(baseEntry.gauge);
    if (!found.has(baseGauge)) {
      found.set(baseGauge, { ...baseEntry, normalizedGauge: baseGauge });
    }

    // Sort by gauge: 1.5CM < 2CM < 3CM
    const gaugeOrder = { '1.5CM': 0, '2CM': 1, '3CM': 2 };
    return [...found.values()].sort((a, b) =>
      (gaugeOrder[a.normalizedGauge] ?? 9) - (gaugeOrder[b.normalizedGauge] ?? 9)
    );
  }

  return {
    lookup,
    lookupSimple,
    lookupSimpleAllGauges,
    tileMap,
    allMaps,
    stats: {
      tile: tileMap.size,
      quartz: quartzMap.size,
      porcelainSlab: porcelainSlabMap.size,
      stone: stoneMap.size,
      total: allMaps.size,
    },
  };
}
