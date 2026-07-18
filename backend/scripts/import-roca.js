/**
 * Roca USA — Full Vendor Import
 *
 * Source: ROCA USA 2026 PRICE BOOK II-JAN.xlsx
 * Both "2026 PRICING" and "2026 SPECIAL ORDER PRICING" sheets.
 *
 * Tile vendor — porcelain, ceramic, mosaics, natural stone, slabs, pavers.
 * Prices are dealer/wholesale cost (F.O.B. warehouse). Retail = cost × 2.
 *
 * Product grouping: collection + color = product.
 * Different sizes/finishes within the same color = different SKUs.
 * Trim pieces (bullnose, cove base, pencil) = accessory SKUs.
 *
 * Usage: docker compose exec api node scripts/import-roca.js
 */
import pg from 'pg';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ─── Category IDs ───
const CAT = {
  porcelain:  '650e8400-e29b-41d4-a716-446655440012',
  ceramic:    '650e8400-e29b-41d4-a716-446655440013',
  mosaic:     '650e8400-e29b-41d4-a716-446655440014',
  naturalStone: '650e8400-e29b-41d4-a716-446655440011',
  porcelainSlab: '650e8400-e29b-41d4-a716-446655440045',
  pavers:     '650e8400-e29b-41d4-a716-446655440062',
  woodLook:   '650e8400-e29b-41d4-a716-446655440015',
  wallTile:   '650e8400-e29b-41d4-a716-446655440050',
  bathAccessories: '03ab6adf-d7b2-463b-a1a4-9efa0e7cdc05',
};

// ─── Attribute IDs ───
const ATTR = {
  color:    'd50e8400-e29b-41d4-a716-446655440001',
  size:     'd50e8400-e29b-41d4-a716-446655440004',
  material: 'd50e8400-e29b-41d4-a716-446655440002',
  finish:   'd50e8400-e29b-41d4-a716-446655440003',
  shape:    '6af46612-5e54-4019-9972-13a3f0b4cb63',
};

const MARKUP = 2.0;

// ─── Category mapping from material string + SKU type ───
function getCategoryId(material, collectionName, skuType) {
  const m = material.toUpperCase();
  const c = collectionName.toUpperCase();
  const t = (skuType || '').toUpperCase();
  // Collection-level overrides first (these are definitive)
  if (c.startsWith('CC MOSAICS') || c.startsWith('CC PORCELAIN')) return CAT.mosaic;
  if (c.includes('ROCKART') || c.includes('METALS')) return CAT.mosaic;
  if (c === 'SLABS' || c === 'XL SLABS') return CAT.porcelain;
  if (c === 'PAVERS') return CAT.pavers;
  if (c === 'BATH FIXTURES') return CAT.bathAccessories;
  // SKU-level type overrides: mosaic items in non-mosaic collections
  if (t === 'MOSAIC') return CAT.mosaic;
  // SKU-level type overrides: ceramic wall items
  if (t === 'CERAMIC WALL' || t === 'PORCELAIN WALL' || t === 'WALL') return CAT.wallTile;
  if (m.includes('NATURAL STONE') || m.includes('GLASS MOSAIC')) return CAT.mosaic;
  if (m.includes('ALUMINUM')) return CAT.mosaic;
  if (c === 'PINE' || c === 'NORTHWOOD' || c === 'WESTON') return CAT.woodLook;
  if (m.includes('CERAMIC WALL')) return CAT.wallTile;
  if (m.includes('PORCELAIN')) return CAT.porcelain;
  if (m.includes('QUARRY')) return CAT.ceramic;
  if (m.includes('CERAMIC')) return CAT.wallTile;
  if (m.includes('STONEWARE')) return CAT.porcelain;
  return CAT.porcelain; // default
}

// ─── Parse a pricing sheet ───
function parseSheet(ws, sheetType) {
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const records = [];
  let collection = null;
  let currentSize = '', currentPrice = null, currentUom = 'SF';
  let currentPcsBox = null, currentSfBox = null, currentBxsPallet = null;
  let currentType = '';

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (sheetType === 'main') {
      const col1 = String(row[1] || '').trim();
      const col2 = String(row[2] || '').trim();
      const col3 = String(row[3] || '').trim();
      const col4 = String(row[4] || '').trim();
      const col5 = String(row[5] || '').trim();

      // Collection header: "ABACO    - GLAZED PORCELAIN" or "AVENUE-GLAZED PORCELAIN"
      // Left side must be letters/spaces/punctuation only (no digits) to avoid matching SKU codes
      const mainHeaderMatch = col2 !== 'SKU' && !col2.startsWith('*') && col2.match(/^([A-Za-z][A-Za-z &'.+]+?)\s*-\s*(.+)$/);
      if (mainHeaderMatch && !/\d/.test(mainHeaderMatch[1]) && !/\d/.test(mainHeaderMatch[2])) {
        collection = {
          name: mainHeaderMatch[1].replace(/\s+/g, ' ').trim(),
          material: mainHeaderMatch[2].replace(/\s+/g, ' ').trim(),
        };
        currentSize = ''; currentPrice = null; currentType = '';
        currentPcsBox = null; currentSfBox = null; currentBxsPallet = null;
        continue;
      }
      if (col2 === 'SKU') continue;
      if (!collection) continue;

      // Type detection
      const typeLabels = ['FLOOR', 'WALL', 'TRIM', 'MOSAIC', 'DECO', 'BULLNOSE', 'COVE BASE',
        'FLOOR & WALL', 'FLOOR&WALL', 'CERAMIC WALL', 'PORCELAIN WALL'];
      if (typeLabels.includes(col1)) currentType = col1;

      const sku = col2.replace(/\*+$/, '').trim();
      const desc = col4;
      if (!sku || !desc || sku.length < 4) continue;

      if (col3) currentSize = col3;
      if (row[6] !== '' && row[6] != null) currentPrice = parseFloat(row[6]);
      if (col5) currentUom = col5;
      if (row[7] !== '' && row[7] != null) currentPcsBox = parseFloat(row[7]);
      if (row[8] !== '' && row[8] != null) currentSfBox = parseFloat(row[8]);
      if (row[10] !== '' && row[10] != null) currentBxsPallet = parseFloat(row[10]);

      records.push({
        collection: collection.name, material: collection.material,
        sku, desc, sizeLabel: currentSize, type: currentType || 'FLOOR',
        uom: currentUom, price: currentPrice,
        pcsBox: currentPcsBox, sfBox: currentSfBox, bxsPallet: currentBxsPallet,
        specialOrder: false,
      });
    } else {
      // Special order sheet (columns shifted left by 1)
      const col0 = String(row[0] || '').trim();
      const col1 = String(row[1] || '').trim();
      const col2 = String(row[2] || '').trim();
      const col3 = String(row[3] || '').trim();
      const col4 = String(row[4] || '').trim();

      const soHeaderMatch = col1 !== 'SKU' && col1.match(/^([A-Za-z][A-Za-z &'.+]+?)\s*-\s*(.+)$/);
      if (soHeaderMatch && !/\d/.test(soHeaderMatch[1]) && !/\d/.test(soHeaderMatch[2])) {
        collection = {
          name: soHeaderMatch[1].replace(/\s+/g, ' ').trim(),
          material: soHeaderMatch[2].replace(/\s+/g, ' ').trim(),
        };
        currentSize = ''; currentPrice = null; currentType = '';
        currentPcsBox = null; currentSfBox = null; currentBxsPallet = null;
        continue;
      }
      if (col1 === 'SKU') continue;
      if (!collection) continue;

      if (['FLOOR', 'WALL', 'TRIM', 'MOSAIC'].includes(col0)) currentType = col0;

      const sku = col1.replace(/\*+$/, '').trim();
      const desc = col3;
      if (!sku || !desc || sku.length < 4 || sku.startsWith('(')) continue;

      if (col2) currentSize = col2;
      if (row[5] !== '' && row[5] != null) currentPrice = parseFloat(row[5]);
      if (col4) currentUom = col4;
      if (row[6] !== '' && row[6] != null) currentPcsBox = parseFloat(row[6]);
      if (row[7] !== '' && row[7] != null) currentSfBox = parseFloat(row[7]);
      if (row[9] !== '' && row[9] != null) currentBxsPallet = parseFloat(row[9]);

      records.push({
        collection: collection.name, material: collection.material,
        sku, desc, sizeLabel: currentSize, type: currentType || col0 || 'FLOOR',
        uom: currentUom, price: currentPrice,
        pcsBox: currentPcsBox, sfBox: currentSfBox, bxsPallet: currentBxsPallet,
        specialOrder: true,
      });
    }
  }
  return records;
}

// ─── Title-case helper ───
function titleCase(str) {
  return str.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
    .replace(/\bOf\b/g, 'of').replace(/\bAnd\b/g, 'and').replace(/\bDe\b/g, 'de')
    .replace(/\bDi\b/g, 'di').replace(/\bDu\b/g, 'du');
}

// ─── Extract color from description ───
function extractColor(desc, collectionName) {
  let text = desc.trim();
  const isMosaicCollection = /^CC\s+(MOSAICS?|PORCELAIN)/i.test(collectionName);

  // Remove common prefixes
  text = text.replace(/^SUITE\s+/i, '');
  text = text.replace(/^LM\s+/i, '');
  // For CC collections, expand BG/MG finish prefix to full name
  if (collectionName.toUpperCase().startsWith('CC ')) {
    text = text.replace(/^MG\s+/i, 'Matte ');
    text = text.replace(/^BG\s+/i, 'Bright ');
  }
  // CC / BG / MG prefix removal (for Color Collection, etc.)
  if (/^(CC|BG|MG)\s+/i.test(text) &&
    !collectionName.toUpperCase().startsWith('CC ')) {
    text = text.replace(/^(CC|BG|MG)\s+/i, '');
  }

  // Remove collection name prefix (also handle abbreviated forms like "CC PORCE" for "CC PORCELAIN")
  const colClean = collectionName.replace(/[^A-Za-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const textUpper = text.toUpperCase();
  if (textUpper.startsWith(colClean + ' ')) {
    text = text.substring(colClean.length + 1);
  } else if (textUpper === colClean) {
    text = ''; // description IS just the collection name
  } else if (colClean.length >= 6) {
    // Try abbreviated prefix match: if desc starts with first 6+ chars of collection name
    // e.g., "CC PORCE TENDER GRAY..." matches "CC PORCELAIN" (shares "CC PORCE")
    for (let len = colClean.length; len >= 6; len--) {
      const prefix = colClean.substring(0, len);
      if (textUpper.startsWith(prefix + ' ')) {
        text = text.substring(prefix.length + 1);
        break;
      }
    }
  }
  text = text.trim();

  // For mosaic collections, extract specific shape/pattern BEFORE stripping sizes
  // (size stripping removes everything after the first NxN, losing shape words)
  let mosaicShape = '';
  if (isMosaicCollection) {
    const u = text.toUpperCase();
    let m;
    // Multi-word patterns (most specific first)
    if (/\bDIAMOND\s+HERRING/i.test(u)) mosaicShape = 'Diamond Herringbone';
    else if (/\bFLOWER\s+HEX/i.test(u)) mosaicShape = 'Flower Hexagon';
    else if (/\bBASKET\s+WEAVE/i.test(u)) mosaicShape = 'Basket Weave';
    else if (/\b3D\s+PICKET/i.test(u)) mosaicShape = '3D Picket';
    // Sized patterns: piece size (single-digit NxN) + shape
    else if ((m = u.match(/\b([1-6])[xX]([1-6])\s+BEV\.?\s*BRICK/))) mosaicShape = `${m[1]}x${m[2]} Beveled Brick`;
    else if ((m = u.match(/\b([1-6])[xX]([1-6])\s+T-?BRICK/))) mosaicShape = `${m[1]}x${m[2]} T-Brick`;
    else if ((m = u.match(/\b([1-6])[xX]([1-6])\s+BRICK/))) mosaicShape = `${m[1]}x${m[2]} Brick`;
    else if ((m = u.match(/\b([1-6])[xX]([1-6])\s+SQUARES?/))) mosaicShape = `${m[1]}x${m[2]} Squares`;
    else if ((m = u.match(/\b([1-6])[xX]([1-6])\s+HEX(?:AGON)?/))) mosaicShape = `${m[1]}x${m[2]} Hexagon`;
    else if ((m = u.match(/(?:MOS\.?\s*)?HEX(?:AGON)?\s+([1-6])[xX]([1-6])/))) mosaicShape = `${m[1]}x${m[2]} Hexagon`;
    else if ((m = u.match(/\bHEX\s+MOSAIC\s+([1-6])[xX]([1-6])/))) mosaicShape = `${m[1]}x${m[2]} Hexagon`;
    // Single-word shape patterns
    else if (/\bPINWHEEL/i.test(u)) mosaicShape = 'Pinwheel';
    else if (/\bLANTERN/i.test(u)) mosaicShape = 'Lantern';
    else if (/\bHERRING(?:BONE|\.)/i.test(u)) mosaicShape = 'Herringbone';
    else if (/\bOCT(?:AGON)?\b/i.test(u)) mosaicShape = 'Octagon';
    // Shapes already preserved in text after stripping (no extraction needed)
    // PENNY ROUND, STACKED, PICKET, OVAL, FEATHER, DOTS — handled by existing logic

    // Generic "Mosaic" fallback only if no specific shape detected
    if (!mosaicShape) {
      const afterSize = text.match(/\d+[xX×]\d+\s+(.+)$/i);
      if (afterSize && /\b(MOS|MOSAIC)\b/i.test(afterSize[1])) mosaicShape = 'Mosaic';
      else if (/\b(MOSAIC|MOS)\s*$/i.test(text)) mosaicShape = 'Mosaic';
    }

    // Expand standalone PENNY to PENNY ROUND
    text = text.replace(/\bPENNY\b(?!\s+ROUND)/i, 'PENNY ROUND');
  }

  // Normalize Unicode curly quotes to ASCII (XLSX sometimes uses U+201C/U+201D)
  text = text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");

  // Remove size dimensions (order matters — specific patterns before general ones)
  // Quoted size in middle of text: "CRACKLED 3"X12" AQUA" → "CRACKLED AQUA"
  // (for descriptions where color appears after a quoted size)
  text = text.replace(/\s+\d+["']\s*[xX×]\s*\d+["']\s+/i, ' ');
  // Fractional size at start: "8 1/2X8 1/2 ...", "2 1/2X6 ..."
  text = text.replace(/^\d+\s+\d+\/\d+\s*[xX]\s*\d+(\s+\d+\/\d+)?\s*/i, '');
  // NxN at start (XL SLABS: "48X110 R SERENA...", "12"x24"")
  text = text.replace(/^\d+(?:\.\d+)?["']*\s*[xX×]\s*\d+(?:\.\d+)?["']*\s*R?\s*/i, '');
  // "2. 5x5" (XLSX decimal split with space) — must be before general NxN
  text = text.replace(/\s+\d+\.\s+\d+[xX]\d+.*$/i, '');
  // Fractional sizes: 4 1/4X4 1/4
  text = text.replace(/\s+\d+\s+\d+\/\d+\s*[xX]\s*\d+\s+\d+\/\d+.*$/i, '');
  // XLSX typo: "4 1X4X4 1/4" (missing slash in fraction)
  text = text.replace(/\s+\d+\s+\d+[xX]\d+[xX]\d+\s+\d+\/\d+.*$/i, '');
  // Standard NxN patterns with quotes/decimals: 12"x24", 12X24, 8X48R, 2.5x5, 10.5x64r
  text = text.replace(/\s+\d+(?:\.\d+)?["']*\s*[xX×]\s*\d+(?:\.\d+)?["']*[R]?(\s.*$|$)/i, '');
  // Fraction x integer sizes: 3/4X10, 7/8X6 (also handles "4 1/4X10" mixed number)
  text = text.replace(/\s+(\d+\s+)?\d+\/\d+\s*[xX]\s*\d+.*$/i, '');
  // Size glued to word: "GRAY4X12" → strip "4X12"
  text = text.replace(/(?<=[A-Za-z])\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?$/i, '');
  // Standalone size like "20X20" at end
  text = text.replace(/\s+\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?[r]?$/i, '');

  // Strip trailing fractional size patterns: "2X3/4 OC", "2 X3/4 OUTCORNER"
  text = text.replace(/\s+\d+\s*[xX]\d+\/\d+(\s+\S+)*$/i, '');

  // Remove trailing finish/surface/trim codes
  const codes = ['R', 'PO', 'UP', 'MT', 'MC', 'ST', 'ABS', 'BG', 'MG',
    'SBN', 'BN', 'MOS', 'MOSAIC', 'HEXAGON', 'OCT',
    'BRIGHT', 'MATTE', 'PENCIL', 'PEN', 'OC', 'W/'];
  for (let pass = 0; pass < 3; pass++) {
    for (const code of codes) {
      const re = new RegExp(`\\s+${code.replace('/', '\\/')}(\\s+\\S+)?$`, 'i');
      // Only strip if it's not the ENTIRE remaining text
      const stripped = text.replace(re, '');
      if (stripped.trim().length > 0) text = stripped;
    }
  }

  // Remove "W/ BLK" etc.
  text = text.replace(/\s+W\/\s+\S+$/i, '');

  // Remove leading/trailing whitespace + normalize
  text = text.replace(/\s+/g, ' ').trim();

  // Expand abbreviated color names to full names
  // Dotted abbreviations (most specific first)
  text = text.replace(/\bS\.\s*white\b/gi, 'Snow White');
  text = text.replace(/\bT\.\s*gray\b/gi, 'Tender Gray');
  text = text.replace(/\bVel\.\s*/gi, 'Velvet ');
  text = text.replace(/\bAt\.\s*/gi, 'Atoll ');
  text = text.replace(/\bP\.\s+/gi, 'Peacock ');
  text = text.replace(/\bBru\.\s*/gi, 'Brushed ');
  // Compound abbreviations (before single-word to avoid partial replacement)
  text = text.replace(/\bClst\s*&\s*/gi, 'Celestial & ');
  text = text.replace(/\bMrbl\s*&\s*/gi, 'Marble & ');
  text = text.replace(/\bGr\s*&\s*w\b/gi, 'Gray & White');
  text = text.replace(/\bWh\s*&\s*bl\b/gi, 'White & Black');
  text = text.replace(/\bB\s*&\s*w\b/gi, 'Black & White');
  text = text.replace(/\bWh\s*\/\s*blk\b/gi, 'White & Black');
  // Single-word abbreviations
  text = text.replace(/\bClst\b/gi, 'Celestial');
  text = text.replace(/\bCelest\b/gi, 'Celestial');
  text = text.replace(/\bMrbl\b/gi, 'Marble');
  text = text.replace(/\bRnd\b/gi, 'Round');
  text = text.replace(/\bSn\b/gi, 'Snow');
  text = text.replace(/\bWh\b/gi, 'White');
  text = text.replace(/\bGr\b/gi, 'Gray');
  text = text.replace(/\bBlk\b/gi, 'Black');
  text = text.replace(/\bBw\b/gi, 'Black & White');
  text = text.replace(/\bBl\b/gi, 'Blanco');
  text = text.replace(/\bAr\b/gi, 'Arena');
  text = text.replace(/\s+/g, ' ').trim();

  // Expand standalone finish codes to readable names
  const finishCodes = {
    'po': 'Polished', 'up': 'Unpolished', 'mt': 'Matte',
    'abs': 'Abrasive', 'mg': 'Matte'
  };
  if (finishCodes[text.toLowerCase()]) text = finishCodes[text.toLowerCase()];

  // For mosaic collections: append shape if the result is just a color (no shape word present)
  if (isMosaicCollection && mosaicShape && text) {
    const hasShape = /\b(PENNY|ROUND|STACKED|PICKET|OVAL|FEATHER|HEXAGON|HEX|BRICK|HERRING|BASKET|3D|DOTS?|OCTAGON|OCT|LANTERN|PINWHEEL|DIAMOND|SQUARES?|FLOWER|BEVELED)\b/i.test(text);
    if (!hasShape) {
      text = text + ' ' + mosaicShape;
    }
  }

  return text || desc.replace(/\s+\d+.*$/, '').trim() || desc;
}

// ─── Extract finish/surface code from raw description ───
// Returns a human-readable finish label, or '' if none found.
// Used to distinguish SKUs that share the same product name + size.
function extractFinish(desc) {
  const u = desc.toUpperCase();
  // Check for surface finish codes (order: most specific first)
  const finishMap = [
    [/\bPO\b/, 'Polished'], [/\bUP\b/, 'Unpolished'],
    [/\bMT\b/, 'Matte'], [/\bMC\b/, 'Matte Calibrated'],
    [/\bST\b/, 'Structured'], [/\bABS\b/, 'Abrasive'],
    [/\bBRIGHT\b/, 'Bright'], [/\bMATTE\b/, 'Matte'],
  ];
  for (const [re, label] of finishMap) {
    if (re.test(u)) return label;
  }
  // BG/MG prefix (Bright Glossy / Matte Glossy) — only at start of description
  if (/^BG\s/i.test(desc.trim())) return 'Bright';
  if (/^MG\s/i.test(desc.trim())) return 'Matte';
  return '';
}

// ─── Parse mosaic product name into color + shape ───
// CC Mosaics names: "[Finish] [Color] [Shape]" e.g. "Bright White Penny Round"
// CC Porcelain names: "[Color] [Shape]" e.g. "Taupe Stacked"
function parseMosaicName(productName) {
  let text = productName.trim();
  let finish = '';

  // 1. Extract finish prefix
  if (/^Bright\s+/i.test(text)) {
    finish = 'Bright';
    text = text.replace(/^Bright\s+/i, '');
  } else if (/^Matte\s+/i.test(text)) {
    finish = 'Matte';
    text = text.replace(/^Matte\s+/i, '');
  }
  // Finish suffix (e.g., "Stacked White Glossy")
  const suffixMatch = text.match(/\s+(Glossy)$/i);
  if (suffixMatch) {
    if (!finish) finish = suffixMatch[1];
    text = text.substring(0, suffixMatch.index);
  }

  // 2. Match shape from end (most specific patterns first)
  let shape = '';
  const shapePatterns = [
    /\b(\d+[xX]\d+\s+Beveled\s+Brick)$/i,
    /\b(\d+[xX]\d+\s+T-?Brick)$/i,
    /\b(\d+[xX]\d+\s+Brick)$/i,
    /\b(\d+[xX]\d+\s+Hexagon)$/i,
    /\b(\d+[xX]\d+\s+Squares?)$/i,
    /\b(Diamond\s+Herringbone)$/i,
    /\b(Flower\s+Hexagon)$/i,
    /\b(Basket\s+Weave)$/i,
    /\b(3[dD]\s+Picket)$/i,
    /\b(Penny\s+Round)$/i,
    /\b(Herringbone)$/i,
    /\b(Octagon)$/i,
    /\b(Picket)$/i,
    /\b(Stacked)$/i,
    /\b(Oval)$/i,
    /\b(Lantern)$/i,
    /\b(Feather)$/i,
    /\b(Pinwheel)$/i,
    /\b(Mosaic)$/i,
    /\b(Dots)$/i,
    /\b(Brick)$/i,
  ];

  for (const pat of shapePatterns) {
    const m = text.match(pat);
    if (m) {
      shape = m[1];
      text = text.substring(0, m.index).trim();
      break;
    }
  }

  // Handle "Stacked" at the start when no shape matched from end
  if (!shape && /^Stacked\s+/i.test(text)) {
    shape = 'Stacked';
    text = text.replace(/^Stacked\s*/i, '');
  }

  // 3. Move leading size prefix from color to shape (e.g., '2"' from '2" White' after extracting 'Dots')
  const sizePrefix = text.match(/^(\d+"?)\s+/);
  if (sizePrefix && shape) {
    shape = sizePrefix[1] + ' ' + shape;
    text = text.substring(sizePrefix[0].length);
  }

  return { finish, color: text.trim(), shape };
}

// ─── Detect if a SKU is a trim/accessory ───
function isTrim(record) {
  const t = record.type.toUpperCase();
  const s = record.sizeLabel.toUpperCase();
  const d = record.desc.toUpperCase();
  return t === 'TRIM' || t === 'BULLNOSE' || t === 'COVE BASE' ||
    s.includes('BULLNOSE') || s.includes('PENCIL') || s.includes('COVE') ||
    s.includes('V-CAP') || s.includes('RADIUS') || s.includes('QUARTER ROUND') ||
    s.includes('CHAIR RAIL') ||
    d.includes(' SBN ') || d.endsWith(' SBN') || d.includes(' BN ') || d.endsWith(' BN') ||
    d.includes(' PENCIL') || d.includes(' COVE') || d.includes(' V-CAP') ||
    d.includes(' RAD BN') || d.includes(' RAD CRN');
}

// ─── Extract a clean size string from the size label ───
function cleanSize(sizeLabel) {
  if (!sizeLabel) return '';
  return sizeLabel.replace(/\s+(FIELD|BULLNOSE|PENCIL|HEXAGON|MOSAIC|COVE|COVE BASE|V-CAP|RADIUS|CORNER|QUARTER ROUND|CHAIR RAIL).*$/i, '').trim();
}

// ─── Normalize collection names for merging ───
function normalizeCollectionName(name) {
  return name.replace(/\s+/g, ' ').trim()
    .replace(/^COLOR COLLECTION - TRIMS?$/i, 'Color Collection')
    .replace(/^CC MOSAICS?\s*\+*$/i, 'CC Mosaics')
    .replace(/^CC MOSAIC\s*\+{1,}$/i, 'CC Mosaics')
    .replace(/^MAIOLICA\s*(FLOOR)?$/i, 'Maiolica');
}

// ─── Main import function ───
async function run() {
  // Read the Excel file
  const xlsxPath = join(__dirname, '..', 'data', 'roca-2026-pricebook.xlsx');
  const wb = XLSX.readFile(xlsxPath);

  const mainRecords = parseSheet(wb.Sheets['2026 PRICING'], 'main');
  const soRecords = parseSheet(wb.Sheets['2026 SPECIAL ORDER PRICING'], 'so');
  const allRecords = [...mainRecords, ...soRecords];

  console.log(`Parsed ${mainRecords.length} main + ${soRecords.length} special order = ${allRecords.length} total SKUs\n`);

  // ── Group by collection + color → products ──
  // Key = normalized collection name + "|" + color
  const productMap = new Map(); // key → { collection, material, color, skus[] }

  for (const rec of allRecords) {
    const normCol = normalizeCollectionName(rec.collection);
    let color = extractColor(rec.desc, rec.collection);
    // Detect mosaic items by type label OR description keyword
    const isMosaicCol = /^CC\s+(MOSAICS?|PORCELAIN)/i.test(rec.collection) ||
      /ROCKART|METALS/i.test(rec.collection) ||
      /NATURAL STONE|GLASS MOSAIC/i.test(rec.material);
    const isMosaicItem = rec.type.toUpperCase() === 'MOSAIC' || /\bMOSAIC\b/i.test(rec.desc);
    if (!isMosaicCol && isMosaicItem && !/\bMosaic\b/i.test(color)) {
      color = color + ' Mosaic';
    }
    // Use effective type for category: override to MOSAIC if description indicates it
    const effectiveType = (!isMosaicCol && isMosaicItem) ? 'MOSAIC' : rec.type;
    const key = `${normCol}|${titleCase(color)}`;

    if (!productMap.has(key)) {
      productMap.set(key, {
        collection: titleCase(normCol),
        material: rec.material,
        color: titleCase(color),
        categoryId: getCategoryId(rec.material, rec.collection, effectiveType),
        skus: [],
      });
    }
    productMap.get(key).skus.push(rec);
  }

  console.log(`Grouped into ${productMap.size} products\n`);

  // ── Insert into DB ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert vendor
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Roca USA', 'ROCA', 'https://rocatileusa.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Roca USA (${vendorId})\n`);

    let totalProducts = 0, totalFloorSkus = 0, totalTrimSkus = 0;
    let totalPricing = 0, totalPkg = 0, totalAttrs = 0;

    for (const [key, prod] of productMap) {
      const productName = prod.color || prod.collection;

      // Insert product
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, productName, prod.collection, prod.categoryId]);
      const productId = prodRes.rows[0].id;
      totalProducts++;

      // Separate field tiles from trims
      const fieldSkus = prod.skus.filter(s => !isTrim(s));
      const trimSkus = prod.skus.filter(s => isTrim(s));

      // Detect which sizes have multiple field SKUs (need finish to disambiguate)
      const sizeGroups = new Map(); // size → [rec, ...]
      for (const rec of fieldSkus) {
        const size = cleanSize(rec.sizeLabel);
        if (!sizeGroups.has(size)) sizeGroups.set(size, []);
        sizeGroups.get(size).push(rec);
      }

      // Pre-compute finishes per size group to detect when finish alone doesn't disambiguate
      const sizeFinishes = new Map(); // size → [finish, finish, ...]
      for (const [size, group] of sizeGroups) {
        if (group.length > 1) {
          const finishes = group.map(r => extractFinish(r.desc));
          sizeFinishes.set(size, finishes);
        }
      }

      // Insert field tile SKUs
      for (const rec of fieldSkus) {
        const internalSku = 'ROCA-' + rec.sku;
        const size = cleanSize(rec.sizeLabel);
        let variantName = `${productName} ${size}`.trim();
        // Append finish when multiple SKUs share the same size within this product
        const group = sizeGroups.get(size);
        if (group.length > 1) {
          const idx = group.indexOf(rec);
          const finish = extractFinish(rec.desc);
          const nameHasFinish = finish && productName.toLowerCase().includes(finish.toLowerCase());
          // Check if finishes are unique across the group
          const groupFinishes = sizeFinishes.get(size);
          const finishesUnique = new Set(groupFinishes).size === groupFinishes.length && groupFinishes.every(f => f);

          if (finish && !nameHasFinish && finishesUnique) {
            variantName = `${productName} ${finish} ${size}`.trim();
          } else {
            // Fallback: append A/B/C based on position within the size group
            const letter = String.fromCharCode(65 + idx); // A, B, C...
            variantName = `${productName} ${letter} ${size}`.trim();
          }
        }
        const sellBy = rec.uom === 'PC' ? 'unit' : 'box';

        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active')
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET product_id = EXCLUDED.product_id, variant_name = EXCLUDED.variant_name, sell_by = EXCLUDED.sell_by, status = 'active'
          RETURNING id
        `, [productId, rec.sku, internalSku, variantName, sellBy]);
        const skuId = skuRes.rows[0].id;
        totalFloorSkus++;

        // Pricing
        if (rec.price) {
          const cost = rec.price.toFixed(2);
          const retail = (rec.price * MARKUP).toFixed(2);
          const priceBasis = sellBy === 'unit' ? 'unit' : 'sqft';
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost,
              retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
          `, [skuId, cost, retail, priceBasis]);
          totalPricing++;
        }

        // Packaging
        if (rec.sfBox || rec.pcsBox) {
          const sfBox = rec.sfBox || null;
          const bxPallet = rec.bxsPallet || null;
          const sfPallet = (sfBox && bxPallet) ? +(sfBox * bxPallet).toFixed(2) : null;
          await client.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (sku_id) DO UPDATE SET
              sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
              pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
              boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
              sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet)
          `, [skuId, sfBox, rec.pcsBox || null, bxPallet, sfPallet]);
          totalPkg++;
        }

        // Attributes
        const isMosaicProduct = /^Cc\s+(Mosaics?|Porcelain)$/i.test(prod.collection);
        if (isMosaicProduct && prod.color) {
          // Parse mosaic product name into separate color + shape
          const parsed = parseMosaicName(prod.color);
          await upsertAttr(client, skuId, ATTR.color, parsed.color || 'Multicolor');
          totalAttrs++;
          if (parsed.shape) {
            await upsertAttr(client, skuId, ATTR.shape, parsed.shape);
            totalAttrs++;
          }
          if (parsed.finish) {
            await upsertAttr(client, skuId, ATTR.finish, parsed.finish);
            totalAttrs++;
          }
        } else {
          if (prod.color) {
            await upsertAttr(client, skuId, ATTR.color, prod.color);
            totalAttrs++;
          }
          // Finish attribute (Polished, Unpolished, Matte, Bright, etc.)
          const skuFinish = extractFinish(rec.desc);
          if (skuFinish) {
            await upsertAttr(client, skuId, ATTR.finish, skuFinish);
            totalAttrs++;
          }
        }
        if (size) {
          await upsertAttr(client, skuId, ATTR.size, size);
          totalAttrs++;
        }
        if (prod.material) {
          await upsertAttr(client, skuId, ATTR.material, titleCase(prod.material));
          totalAttrs++;
        }
      }

      // Insert trim/accessory SKUs
      for (const rec of trimSkus) {
        const internalSku = 'ROCA-' + rec.sku;
        const size = cleanSize(rec.sizeLabel);
        const trimType = rec.sizeLabel.replace(/^[\d\s\/]+[xX][\d\s\/]+\s*/, '').trim() || 'Trim';
        const variantName = `${productName} ${titleCase(trimType)} ${size}`.replace(/\s+/g, ' ').trim();

        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET product_id = EXCLUDED.product_id, variant_name = EXCLUDED.variant_name, sell_by = 'unit',
                       variant_type = 'accessory', status = 'active'
          RETURNING id
        `, [productId, rec.sku, internalSku, variantName]);
        const skuId = skuRes.rows[0].id;
        totalTrimSkus++;

        // Pricing for trims
        if (rec.price) {
          const cost = rec.price.toFixed(2);
          const retail = (rec.price * MARKUP).toFixed(2);
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'unit')
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
          `, [skuId, cost, retail]);
          totalPricing++;
        }

        // Packaging for trims
        if (rec.sfBox || rec.pcsBox) {
          const sfBox = rec.sfBox || null;
          const bxPallet = rec.bxsPallet || null;
          const sfPallet = (sfBox && bxPallet) ? +(sfBox * bxPallet).toFixed(2) : null;
          await client.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (sku_id) DO UPDATE SET
              sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
              pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
              boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
              sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet)
          `, [skuId, sfBox, rec.pcsBox || null, bxPallet, sfPallet]);
          totalPkg++;
        }
      }

      // Log per-collection stats periodically
      if (totalProducts % 50 === 0) {
        console.log(`  ... ${totalProducts} products processed`);
      }
    }

    await client.query('COMMIT');

    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Field SKUs: ${totalFloorSkus}`);
    console.log(`Trim/Accessory SKUs: ${totalTrimSkus}`);
    console.log(`Total SKUs: ${totalFloorSkus + totalTrimSkus}`);
    console.log(`Pricing records: ${totalPricing}`);
    console.log(`Packaging records: ${totalPkg}`);
    console.log(`Attribute records: ${totalAttrs}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function upsertAttr(client, skuId, attrId, value) {
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

run().catch(err => { console.error(err); process.exit(1); });
