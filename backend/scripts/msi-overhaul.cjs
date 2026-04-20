#!/usr/bin/env node
/**
 * msi-overhaul.cjs
 *
 * Complete MSI data overhaul: fixes product grouping, naming, attributes,
 * images, categories, and descriptions in a single transaction with 8 phases.
 *
 * Current state:  ~5,600 products, ~5,578 SKUs (near 1:1 ratio),
 *                 50% share a primary image, 80% missing collection,
 *                 70% missing size/finish/thickness, 405 uncategorized.
 *
 * Target state:   ~1,500-2,000 clean products (one per collection+color),
 *                 proper accessory separation, repaired attributes,
 *                 clean display names, high image coverage.
 *
 * Usage:
 *   node backend/scripts/msi-overhaul.cjs --dry-run
 *   node backend/scripts/msi-overhaul.cjs --phase 1 --dry-run
 *   node backend/scripts/msi-overhaul.cjs --verbose
 *   node backend/scripts/msi-overhaul.cjs --limit 100
 *   node backend/scripts/msi-overhaul.cjs
 */

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI Arguments
// ─────────────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const phaseIdx = process.argv.indexOf('--phase');
const PHASE_FILTER = phaseIdx !== -1 ? parseInt(process.argv[phaseIdx + 1]) : null;
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1]) : Infinity;

const VENDOR_CODE = 'MSI';

// ─────────────────────────────────────────────────────────────────────────────
// LVP Collection Names (from group-msi-products.cjs) — longest first
// ─────────────────────────────────────────────────────────────────────────────

const LVP_COLLECTIONS = [
  'Wayne Parc Reserve', 'Laurel Reserve', 'Nove Reserve',
  'Wayne Parc', 'Nove Plus', 'XL Prescott', 'XL Trecento',
  'XL Cyrus', 'XL Ashton', 'XL Studio', 'Cyrus 2.0', 'Ashton 2.0',
  'Mc. Reserve', 'Mccarran Reserve',
  'Prescott', 'Trecento', 'Glenridge', 'Andover', 'Mccarran',
  'Kallum', 'Acclima', 'Katavia', 'Wilmont', 'Shorecliffs',
  'Cyrus', 'Laurel', 'Ladson', 'Kelmore', 'Woodhills',
  'Smithcliffs', 'Lofterra', 'Studio', 'Ashton', 'Nove',
  'Chilcott', 'Harvested', 'Mountains',
];

// ─────────────────────────────────────────────────────────────────────────────
// Multi-word series names (from msi-final-fix.cjs) — longest first
// ─────────────────────────────────────────────────────────────────────────────

const MULTI_SERIES = [
  'Regallo Calacatta Marbella', 'Regallo Calacatta Isla',
  'Regallo Marquina Noir', 'Regallo Midnight Agate', 'Regallo Marquinanoir',
  'Chateau Luna', 'Kaya Onda', 'Kaya Zermatta', 'Kaya Calacatta',
  'Traktion Stowe', 'Traktion Maven', 'Traktion Calypso',
  'Carolina Timber', 'New Diana',
  'Snowdrift White', 'Thundercloud Grey', 'Travertino White',
  'Seashell Bianco', 'Dune Silk', 'Gold Green', 'Hawaiian Sky',
  'Hd Blume', 'Hd Toucan', 'Hd Aura',
  'Carrara White', 'Calacatta Gold', 'Crema Marfil',
  'Arabescato Carrara', 'Bianco Dolomite', 'Greecian White',
  'Golden Honey', 'Honey Gold', 'White Oak', 'Arctic White',
  'Silver Travertine', 'Ivory Travertine', 'Tuscany Walnut',
  'Tuscany Beige', 'Tuscany Ivory', 'Tuscany Classic',
  'Tuscany Scabas', 'Tuscany Porcini', 'Tuscany Chocolat',
  'Tuscany Storm', 'Coal Canyon', 'Desert Quartz', 'Sierra Blue',
  'Sage Green', 'Fossil Rustic', 'Mountain Rust',
  'White Quarry', 'Babylon Gray', 'Tierra Sol',
  'Golden White', 'Cosmic Black', 'Alaska Gray',
  'Pietra Calacatta', 'Pietra Statuario', 'Pietra Bernini',
  'Napa Wood', 'Country River',
  'Avalon Bay',
].sort((a, b) => b.length - a.length);

// ─────────────────────────────────────────────────────────────────────────────
// Trim codes (from msi-name-cleanup.cjs) — used for accessory detection
// ─────────────────────────────────────────────────────────────────────────────

const TRIM_CODE_MAP = {
  'ec':      'End Cap',
  'ecl':     'End Cap Long',
  'osn':     'Overlapping Stair Nose',
  'fsn':     'Flush Stair Nose',
  'fsnl':    'Flush Stair Nose Long',
  'qr':      'Quarter Round',
  'sr':      'Reducer',
  'st':      'Stair Tread',
  'rt':      'Riser Tread',
  't':       'T-Molding',
  't-sr':    'T-Molding / Reducer',
  '4-in-1':  '4-in-1 Transition',
  'srl':     'Reducer Long',
};

const TRIM_CODES_SORTED = Object.keys(TRIM_CODE_MAP).sort((a, b) => b.length - a.length);
const TRIM_CODE_RE = new RegExp(
  `\\s+(${TRIM_CODES_SORTED.map(c => c.replace(/-/g, '\\-')).join('|')})(-ee|-sr|-w)?\\s+([\\d.]+"?)\\s*$`,
  'i'
);

// ─────────────────────────────────────────────────────────────────────────────
// Known finish values
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_FINISHES = [
  'Matte', 'Polished', 'Honed', 'Glossy', 'Lappato', 'Satin',
  'Rectified', 'Tumbled', 'Brushed', 'Chiseled', 'Split Face',
  'Splitface', 'Flamed', 'Bush Hammered', 'Sandblasted', 'Leathered',
  'Antiqued', 'Filled', 'Unfilled', 'Natural', 'Textured',
];
const FINISH_RE = new RegExp(`\\b(${KNOWN_FINISHES.join('|')})\\b`, 'i');

// ─────────────────────────────────────────────────────────────────────────────
// Known mosaic patterns
// ─────────────────────────────────────────────────────────────────────────────

const MOSAIC_PATTERNS = [
  'Basketweave', 'Herringbone', 'Hexagon', 'Hex', 'Chevron',
  'Arabesque', 'Picket', 'Penny Round', 'Penny', 'Lantern',
  'Diamond', 'Elongated Hex', 'Brick', 'Subway', 'Fan',
  'Fish Scale', 'Scallop', 'Rhomboid', 'Trapezoid', '3D',
  'Interlocking', 'Stacked',
];
const MOSAIC_PATTERN_RE = new RegExp(`\\b(${MOSAIC_PATTERNS.join('|')})\\b`, 'i');

// ─────────────────────────────────────────────────────────────────────────────
// Stacked stone formats
// ─────────────────────────────────────────────────────────────────────────────

const STONE_FORMATS = [
  'Splitface Panel', 'Split Face Panel', 'Ledger Panel', 'Panel',
  'Corner', 'Coping', 'Paver', 'Cobble', 'Tread',
];
const STONE_FORMAT_RE = new RegExp(`\\b(${STONE_FORMATS.join('|')})\\b`, 'i');

// ─────────────────────────────────────────────────────────────────────────────
// SKU prefix → category mappings
// ─────────────────────────────────────────────────────────────────────────────

const SKU_PREFIX_CATEGORY = [
  // Longest prefixes first for correct matching
  { prefix: 'QUARTZ', slug: 'countertops' },
  { prefix: 'SMOT-SILL', slug: 'transitions-moldings' },
  { prefix: 'SMOT-TH', slug: 'transitions-moldings' },
  { prefix: 'SMOT-CSHELF', slug: 'transitions-moldings' },
  { prefix: 'SMOT', slug: 'mosaic' },
  { prefix: 'STPL', slug: 'stacked-stone' },
  { prefix: 'LPNL', slug: 'stacked-stone' },
  { prefix: 'LPAV', slug: 'stacked-stone' },
  { prefix: 'LHDP', slug: 'stacked-stone' },
  { prefix: 'THDW', slug: 'hardwood' },
  { prefix: 'NHAL', slug: 'natural-stone' },
  { prefix: 'VTR', slug: 'luxury-vinyl' },
  { prefix: 'VTT', slug: 'luxury-vinyl' },
];

// MAC (Material Class) → category slug (from msi-832.js)
const MAC_CATEGORY_MAP = {
  PORTILR: 'tile', PORTILC: 'tile',
  CERTILR: 'tile', CERTILC: 'tile',
  STNTILR: 'natural-stone', STNTILC: 'natural-stone',
  MOSTILR: 'mosaic', MOSTILC: 'mosaic',
  GLSTILR: 'mosaic', GLSTILC: 'mosaic',
  VINTILR: 'luxury-vinyl', VINTILC: 'luxury-vinyl',
  VINFLR: 'luxury-vinyl', SPCFLR: 'luxury-vinyl', WPCFLR: 'luxury-vinyl',
  HRDWDR: 'hardwood', HRDWDC: 'hardwood',
  ENGWDR: 'hardwood', ENGWDC: 'hardwood',
  QRTZSL: 'countertops', GRNSL: 'countertops', MRBSL: 'countertops',
  SLBQTZ: 'countertops', SLBGRN: 'countertops', SLBMRB: 'countertops',
  PREFAB: 'countertops',
  STKSTL: 'stacked-stone', STKSTC: 'stacked-stone', LDGPNL: 'stacked-stone',
  PAVTIL: 'outdoor', OUTDOR: 'outdoor', ARTTURF: 'outdoor',
  SETMTL: 'installation-sundries', GRTCAU: 'installation-sundries',
  TRMACC: 'installation-sundries', VINMISR: 'installation-sundries',
};

// ─────────────────────────────────────────────────────────────────────────────
// Category name → material mapping
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_MATERIAL_MAP = {
  'Porcelain Tile': 'Porcelain',
  'Large Format Tile': 'Porcelain',
  'Ceramic Tile': 'Ceramic',
  'Natural Stone': 'Natural Stone',
  'Marble Tile': 'Marble',
  'Mosaic Tile': 'Mixed',
  'Backsplash Tile': 'Mixed',
  'Backsplash & Wall Tile': 'Mixed',
  'LVP (Plank)': 'SPC',
  'Waterproof Wood': 'SPC',
  'Luxury Vinyl': 'SPC',
  'Engineered Hardwood': 'Engineered Hardwood',
  'Hardscaping': 'Porcelain',
  'Pavers': 'Natural Stone',
  'Stacked Stone': 'Natural Stone',
  'Quartz Countertops': 'Quartz',
  'Granite Countertops': 'Granite',
  'Marble Countertops': 'Marble',
  'Quartzite Countertops': 'Quartzite',
  'Transitions & Moldings': 'Mixed',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Words to keep uppercase */
const UPPERCASE_WORDS = new Set([
  'SPC', 'LVP', 'LVT', 'WPC', 'HD', 'MSI', 'USA', 'II', 'III', 'IV',
  'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', '3D', 'XL',
]);

/** Small words to lowercase in title case (unless first word) */
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor',
  'of', 'in', 'on', 'at', 'to', 'by', 'up', 'as',
]);

function smartTitleCase(str) {
  if (!str) return '';
  return str.replace(/\S+/g, (word, offset) => {
    if (UPPERCASE_WORDS.has(word.toUpperCase()) && /^[A-Z]+$/i.test(word)) return word.toUpperCase();
    if (UPPERCASE_WORDS.has(word)) return word;
    if (/^(I{1,3}|IV|VI{0,3}|IX|XI{0,3})$/i.test(word)) return word.toUpperCase();
    if (/^\d+x\d+$/i.test(word)) return word;
    if (/^\d+"?$/.test(word)) return word;
    if (offset > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function titleCase(s) {
  if (!s) return '';
  return smartTitleCase(s);
}

/** Strip packaging suffixes from product names */
function stripPackaging(name) {
  return name
    .replace(/\s*\(\s*[\d.]+\s*Sf\s*Per\s*Box\s*\)/gi, '')
    .replace(/\s*\(\s*\d+\s*Pcs?\s*Per\s*Box\s*\)/gi, '')
    .replace(/\s*\(\s*[\d.]+\s*Sf\s*\)/gi, '')
    .replace(/\s*-\s*\d+\s*(?:lf|lft)\s*\/\s*(?:crt?|crate)\s*$/i, '')
    .replace(/\s*-\s*\d+[-]?\d*\s*sqft?\s*\/?\s*crate\s*$/i, '')
    .trim();
}

/** Strip thickness concatenated onto names (e.g., "Crema Marfilx.38") */
function stripThickness(name) {
  return name.replace(/(?<=[a-zA-Z])x\.?\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?(?:mm|cm|")?/gi, '');
}

/** Extract size pattern from string */
function extractSize(str) {
  const m = str.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  return m ? `${m[1]}x${m[2]}` : null;
}

function headUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Run a query inside a savepoint so errors don't abort the whole transaction.
 * Usage: await safeTx(client, 'UPDATE ...', [params]) → result or null on error
 */
let _spCounter = 0;
async function safeTx(client, sql, params = []) {
  const sp = `sp_${++_spCounter}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const result = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    if (VERBOSE) console.error(`    safeTx error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Name Parsing Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an MSI product name into structured components.
 * Returns { collection, color, size, finish, pattern, format,
 *           isAccessory, accessoryType, trimLength }
 */
function parseMsiName(name, categoryName, existingCollection, existingColor) {
  const result = {
    collection: null,
    color: null,
    size: null,
    finish: null,
    pattern: null,
    format: null,
    isAccessory: false,
    accessoryType: null,
    trimLength: null,
  };

  if (!name) return result;

  let working = stripPackaging(name);
  working = stripThickness(working);
  working = working.replace(/\s+/g, ' ').trim();

  // ── Step 1: Check for trim/accessory via trim codes ──
  const trimMatch = working.match(TRIM_CODE_RE);
  if (trimMatch) {
    const trimCode = trimMatch[1].toLowerCase();
    result.isAccessory = true;
    result.accessoryType = TRIM_CODE_MAP[trimCode] || trimCode;
    result.trimLength = trimMatch[3] || null;
    // Everything before the trim code is the base name (collection + color)
    working = working.slice(0, trimMatch.index).trim();
  }

  // Also check SKU-prefix-based accessory detection (VTT = vinyl transitions/trim)
  if (!result.isAccessory) {
    const nameUpper = name.toUpperCase();
    if (/\b(BULLNOSE|COVE BASE|CHAIR RAIL|PENCIL LINER|STAIR NOSE|REDUCER|T-MOLDING|QUARTER ROUND|END CAP|V-CAP|MUD CAP|THRESHOLD|TRANSITION|MOLDING)\b/i.test(name)) {
      result.isAccessory = true;
      const accMatch = name.match(/\b(Bullnose|Cove Base|Chair Rail|Pencil Liner|Stair Nose|Reducer|T-Molding|Quarter Round|End Cap|V-Cap|Mud Cap|Threshold|Transition|Molding)\b/i);
      if (accMatch) result.accessoryType = titleCase(accMatch[1]);
    }
  }

  // ── Step 2: Extract size ──
  result.size = extractSize(working);
  if (result.size) {
    working = working.replace(/\d+(?:\.\d+)?\s*[xX×]\s*\d+(?:\.\d+)?/, '').replace(/\s+/g, ' ').trim();
  }

  // ── Step 3: Extract finish ──
  const finishMatch = working.match(FINISH_RE);
  if (finishMatch) {
    result.finish = titleCase(finishMatch[1]);
    // Only strip finish from end or if followed by nothing significant
    const afterFinish = working.slice(working.indexOf(finishMatch[0]) + finishMatch[0].length).trim();
    if (!afterFinish || /^[\s,\-\/]+$/.test(afterFinish) || /^\d/.test(afterFinish)) {
      working = working.slice(0, working.indexOf(finishMatch[0])).trim();
    }
  }

  // ── Step 4: Extract mosaic pattern ──
  const catLower = (categoryName || '').toLowerCase();
  if (catLower.includes('mosaic')) {
    const patMatch = working.match(MOSAIC_PATTERN_RE);
    if (patMatch) {
      result.pattern = titleCase(patMatch[1]);
      working = working.replace(patMatch[0], '').replace(/\s+/g, ' ').trim();
    }
  }

  // ── Step 5: Extract stacked stone format ──
  if (catLower.includes('stacked') || catLower.includes('ledger')) {
    const fmtMatch = working.match(STONE_FORMAT_RE);
    if (fmtMatch) {
      result.format = titleCase(fmtMatch[1]);
      working = working.replace(fmtMatch[0], '').replace(/\s+/g, ' ').trim();
    }
  }

  // ── Step 6: Extract collection and color from remaining text ──
  // Use existing collection if valid (not generic vendor name)
  const genericCollections = new Set([
    'm s international inc.', 'm s international', 'msi', '',
  ]);
  const hasValidCollection = existingCollection &&
    !genericCollections.has(existingCollection.toLowerCase().trim());

  if (hasValidCollection) {
    result.collection = existingCollection.trim();
    // Color = everything in working that isn't the collection prefix
    const collLower = result.collection.toLowerCase();
    const workingLower = working.toLowerCase();
    if (workingLower.startsWith(collLower)) {
      result.color = working.slice(result.collection.length).replace(/^[\s\-]+/, '').trim() || null;
    } else {
      result.color = working.trim() || null;
    }
  } else {
    // Try known collection dictionaries
    const extracted = extractCollectionFromName(working, categoryName);
    result.collection = extracted.collection;
    result.color = extracted.color;
  }

  // ── Step 7: Use existing color attribute as fallback ──
  if (!result.color && existingColor) {
    result.color = existingColor;
  }

  // ── Step 8: Clean up ──
  if (result.color) {
    // Strip trailing artifacts
    result.color = result.color
      .replace(/\s*[-,\/]+\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (result.color.length === 0) result.color = null;
  }

  if (result.collection) {
    result.collection = result.collection.replace(/\s+/g, ' ').trim();
  }

  return result;
}

/**
 * Extract collection and color from a product name using known dictionaries.
 */
function extractCollectionFromName(name, categoryName) {
  const catLower = (categoryName || '').toLowerCase();
  const nameLower = name.toLowerCase();

  // For LVP products, try LVP collection list first
  if (catLower.includes('lvp') || catLower.includes('vinyl') || catLower.includes('waterproof')) {
    for (const coll of LVP_COLLECTIONS) {
      const collLower = coll.toLowerCase().replace(/\./g, '');
      const nameClean = nameLower.replace(/\./g, '');
      if (nameClean.startsWith(collLower + ' ') || nameClean === collLower) {
        const prefixLen = findPrefixLength(name, coll);
        const color = name.slice(prefixLen).replace(/^[\s\-]+/, '').trim();
        let fixedColl = coll;
        if (/^Xl\s/i.test(name)) fixedColl = 'XL' + coll.substring(2);
        if (coll === 'Mc. Reserve') fixedColl = 'Mccarran Reserve';
        return { collection: fixedColl, color: color || null };
      }
    }
  }

  // Try MULTI_SERIES list (all categories)
  for (const ms of MULTI_SERIES) {
    if (nameLower.startsWith(ms.toLowerCase() + ' ') || nameLower === ms.toLowerCase()) {
      const color = name.slice(ms.length).replace(/^[\s\-]+/, '').trim();
      return { collection: titleCase(ms), color: color || null };
    }
  }

  // For stacked stone and hardscaping, use specific patterns
  if (catLower.includes('stacked') || catLower.includes('ledger') || catLower.includes('hardscap')) {
    // Try extracting up to known format word
    const fmtIdx = name.search(/\b(Panel|Corner|Coping|Paver|Cobble|Tread|Splitface|Split Face|Ledger|Veneer|Fieldstone)\b/i);
    if (fmtIdx > 0) {
      return { collection: name.slice(0, fmtIdx).trim(), color: null };
    }
  }

  // Default: first word(s) = collection, rest = color
  // Use two words for collections that commonly have two-word names
  const words = name.split(/\s+/);
  if (words.length >= 3) {
    // Try two-word collection first (more common with tile/stone)
    return { collection: words.slice(0, 2).join(' '), color: words.slice(2).join(' ') || null };
  } else if (words.length === 2) {
    return { collection: words[0], color: words[1] || null };
  } else {
    return { collection: words[0] || name, color: null };
  }
}

/**
 * Find the actual prefix length of a collection in a product name,
 * accounting for case differences and dots.
 */
function findPrefixLength(name, coll) {
  for (let i = coll.length - 2; i <= coll.length + 2; i++) {
    if (i >= 0 && i < name.length && /[\s\-]/.test(name[i])) {
      const prefix = name.substring(0, i).toLowerCase().replace(/\./g, '');
      if (prefix === coll.toLowerCase().replace(/\./g, '')) return i;
    }
  }
  return coll.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  MSI DATA OVERHAUL ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}${PHASE_FILTER != null ? ` — Phase ${PHASE_FILTER} only` : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  // Find vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = $1", [VENDOR_CODE]);
  if (vendorRes.rows.length === 0) { console.error('Vendor MSI not found'); process.exit(1); }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 0: Pre-Load & Metrics
  // ═══════════════════════════════════════════════════════════════════════════

  if (PHASE_FILTER == null || PHASE_FILTER === 0) {
    console.log('─── Phase 0: Pre-Load & Metrics ───\n');
  }

  const beforeMetrics = await gatherMetrics(vendorId);
  console.log('=== BEFORE ===');
  printMetrics(beforeMetrics);
  console.log('');

  // Load all MSI data
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.display_name, p.collection, p.category_id,
           p.status, p.is_active, p.description_long, p.description_short,
           c.name as category_name, c.slug as category_slug
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.collection, p.name
  `, [vendorId]);
  const allProducts = productsRes.rows;

  // Load all SKUs with their attributes
  const skusRes = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.internal_sku, s.variant_name,
           s.variant_type, s.sell_by, s.status
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  // Load all sku_attributes into a map: skuId → { color, size, finish, ... }
  const skuAttrsRes = await pool.query(`
    SELECT sa.sku_id, a.slug, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND s.status = 'active'
  `, [vendorId]);

  const skuAttrsMap = new Map(); // skuId → { color: '', size: '', ... }
  for (const row of skuAttrsRes.rows) {
    if (!skuAttrsMap.has(row.sku_id)) skuAttrsMap.set(row.sku_id, {});
    skuAttrsMap.get(row.sku_id)[row.slug] = row.value;
  }

  // Build product → SKUs map
  const skusByProduct = new Map();
  for (const s of skusRes.rows) {
    if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
    skusByProduct.get(s.product_id).push(s);
  }

  // Load attribute IDs
  const attrRes = await pool.query(
    "SELECT id, slug FROM attributes WHERE slug IN ('color','size','finish','material','thickness','pattern')"
  );
  const attrIds = {};
  for (const row of attrRes.rows) attrIds[row.slug] = row.id;

  // Load category map
  const catRes = await pool.query('SELECT id, slug, name FROM categories');
  const catSlugToId = {};
  const catNameToId = {};
  for (const row of catRes.rows) {
    catSlugToId[row.slug] = row.id;
    catNameToId[row.name] = row.id;
  }

  // Load media_assets for image phase
  const mediaRes = await pool.query(`
    SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.url, ma.sort_order
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY ma.product_id, ma.sort_order
  `, [vendorId]);

  const mediaByProduct = new Map();
  for (const m of mediaRes.rows) {
    if (!mediaByProduct.has(m.product_id)) mediaByProduct.set(m.product_id, []);
    mediaByProduct.get(m.product_id).push(m);
  }

  console.log(`  Loaded ${allProducts.length} active products, ${skusRes.rows.length} active SKUs`);
  console.log(`  SKU attributes: ${skuAttrsRes.rows.length} entries`);
  console.log(`  Media assets: ${mediaRes.rows.length} entries\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Name Parsing Engine (no DB writes)
  // ═══════════════════════════════════════════════════════════════════════════

  if (PHASE_FILTER != null && PHASE_FILTER > 1) {
    console.log('  [Skipping Phase 1 — starting at Phase', PHASE_FILTER, ']\n');
  }

  console.log('─── Phase 1: Name Parsing Engine ───\n');

  // Parse every product name → structured data
  const parsedMap = new Map(); // productId → parsed result
  let parseStats = { total: 0, withCollection: 0, withColor: 0, withSize: 0, withFinish: 0, accessories: 0 };

  let processCount = 0;
  for (const product of allProducts) {
    if (processCount >= LIMIT) break;
    processCount++;

    const skus = skusByProduct.get(product.id) || [];
    // Get existing color from first SKU's attributes
    const firstSku = skus[0];
    const existingAttrs = firstSku ? (skuAttrsMap.get(firstSku.id) || {}) : {};
    const existingColor = existingAttrs.color || null;

    const parsed = parseMsiName(
      product.display_name || product.name,
      product.category_name,
      product.collection,
      existingColor
    );

    parsedMap.set(product.id, parsed);
    parseStats.total++;
    if (parsed.collection) parseStats.withCollection++;
    if (parsed.color) parseStats.withColor++;
    if (parsed.size) parseStats.withSize++;
    if (parsed.finish) parseStats.withFinish++;
    if (parsed.isAccessory) parseStats.accessories++;
  }

  console.log(`  Parsed ${parseStats.total} products:`);
  console.log(`    With collection: ${parseStats.withCollection} (${pct(parseStats.withCollection, parseStats.total)})`);
  console.log(`    With color:      ${parseStats.withColor} (${pct(parseStats.withColor, parseStats.total)})`);
  console.log(`    With size:       ${parseStats.withSize} (${pct(parseStats.withSize, parseStats.total)})`);
  console.log(`    With finish:     ${parseStats.withFinish} (${pct(parseStats.withFinish, parseStats.total)})`);
  console.log(`    Accessories:     ${parseStats.accessories} (${pct(parseStats.accessories, parseStats.total)})`);

  if (VERBOSE) {
    console.log('\n  --- Sample parsed names (first 30) ---');
    let shown = 0;
    for (const [pid, parsed] of parsedMap) {
      if (shown >= 30) break;
      const prod = allProducts.find(p => p.id === pid);
      const label = parsed.isAccessory
        ? `${parsed.collection || '?'} / ${parsed.accessoryType || 'acc'}`
        : `${parsed.collection || '?'} / ${parsed.color || '?'}`;
      console.log(`    "${(prod.display_name || prod.name).slice(0, 50)}" → ${label}`);
      shown++;
    }
  }
  console.log('');

  if (PHASE_FILTER === 1) {
    console.log('[Phase 1 only mode] Done. No database changes.\n');
    await pool.end();
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Product Regrouping
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('─── Phase 2: Product Regrouping ───\n');

  // Build regrouping plan
  const regroupPlan = new Map(); // groupKey → { collection, color, isAccessory, isCatchall, skuIds, sourceProductIds, categoryId }
  const skuNewProduct = new Map(); // skuId → groupKey

  processCount = 0;
  for (const product of allProducts) {
    if (processCount >= LIMIT) break;
    processCount++;

    const skus = skusByProduct.get(product.id) || [];
    if (skus.length === 0) continue;

    const parsed = parsedMap.get(product.id);
    if (!parsed) continue;

    const collection = parsed.collection || product.collection || 'Unknown';

    for (const sku of skus) {
      // Per-SKU color: prefer SKU-level attribute, fall back to parsed
      const skuAttrs = skuAttrsMap.get(sku.id) || {};
      const color = skuAttrs.color || parsed.color || '';
      const isAccessory = parsed.isAccessory ||
        sku.variant_type === 'accessory' ||
        /^VTT/i.test(sku.vendor_sku || '') ||
        /^TTR/i.test(sku.vendor_sku || '');

      let key;
      if (isAccessory) {
        // Group accessories by collection + color
        const normColor = color ? norm(color) : '';
        key = normColor
          ? `${norm(collection)}|||${normColor}|||ACCESSORIES`
          : `${norm(collection)}|||ACCESSORIES`;
      } else if (color) {
        key = `${norm(collection)}|||${norm(color)}`;
      } else {
        key = `${norm(collection)}|||CATCHALL`;
      }

      skuNewProduct.set(sku.id, key);

      if (!regroupPlan.has(key)) {
        regroupPlan.set(key, {
          collection,
          color: isAccessory ? '' : color,
          isAccessory,
          isCatchall: !isAccessory && !color,
          skuIds: [],
          sourceProductIds: new Set(),
          categoryId: product.category_id,
        });
      }

      const group = regroupPlan.get(key);
      group.skuIds.push(sku.id);
      group.sourceProductIds.add(product.id);
      // Use first non-empty values as canonical
      if (!group.isAccessory && !group.isCatchall && color && !group.color) {
        group.color = color;
      }
      if (!group.categoryId && product.category_id) {
        group.categoryId = product.category_id;
      }
    }
  }

  const fieldGroups = [...regroupPlan.values()].filter(g => !g.isAccessory && !g.isCatchall);
  const accGroups = [...regroupPlan.values()].filter(g => g.isAccessory);
  const catchGroups = [...regroupPlan.values()].filter(g => g.isCatchall);

  console.log(`  Regrouping plan: ${regroupPlan.size} target products (from ${allProducts.length})`);
  console.log(`    Field tile (collection+color): ${fieldGroups.length}`);
  console.log(`    Accessory:                     ${accGroups.length}`);
  console.log(`    Catchall (no color):           ${catchGroups.length}`);

  // Show SKU distribution
  const groupSizes = [...regroupPlan.values()].map(g => g.skuIds.length).sort((a, b) => b - a);
  const avgSize = groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length;
  console.log(`    Avg SKUs/group: ${avgSize.toFixed(1)}, Max: ${groupSizes[0]}`);

  if (VERBOSE) {
    console.log('\n  --- Sample regrouping (first 30) ---');
    let shown = 0;
    for (const [key, group] of regroupPlan) {
      if (shown >= 30) break;
      const label = group.isAccessory ? `${group.collection} Trim & Accessories`
        : group.isCatchall ? `${group.collection} (catchall)`
        : `${group.collection} ${titleCase(group.color)}`;
      console.log(`    "${label}" — ${group.skuIds.length} SKUs from ${group.sourceProductIds.size} products`);
      shown++;
    }
    if (regroupPlan.size > 30) console.log(`    ... and ${regroupPlan.size - 30} more`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // Execute in transaction (Phases 2-8)
  // ═══════════════════════════════════════════════════════════════════════════

  if (DRY_RUN) {
    console.log('[DRY RUN] Simulating remaining phases...\n');
    console.log(`  Phase 2 (Regrouping): ${allProducts.length} → ${regroupPlan.size} products`);
    console.log(`  Phase 3 (Names):      ${regroupPlan.size} display names to set`);
    console.log(`  Phase 4 (Attributes): ${skusRes.rows.length} SKUs to check/repair`);
    console.log(`  Phase 5 (Images):     image inheritance + CDN probing`);
    console.log(`  Phase 6 (Categories): uncategorized + status cleanup`);
    console.log(`  Phase 7 (Descriptions): propagate from siblings`);
    console.log(`  Phase 8 (Validation): verify integrity + search refresh\n`);
    console.log('[DRY RUN] No database changes made. Remove --dry-run to execute.\n');
    await pool.end();
    return;
  }

  // ── LIVE EXECUTION ──

  const stats = {
    products_created: 0,
    products_reused: 0,
    skus_moved: 0,
    products_deactivated: 0,
    display_names_set: 0,
    variant_names_updated: 0,
    attrs_color: 0,
    attrs_size: 0,
    attrs_finish: 0,
    attrs_material: 0,
    attrs_thickness: 0,
    attrs_garbage_deleted: 0,
    images_inherited: 0,
    images_cdn_probed: 0,
    images_collection_shared: 0,
    accessory_type_fixed: 0,
    categories_fixed: 0,
    collections_set: 0,
    status_fixed: 0,
    descriptions_propagated: 0,
    search_vectors_refreshed: 0,
    media_reparented: 0,
    fk_updates: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Transaction started.\n');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 2 EXECUTION: Create/reuse target products, move SKUs
    // ═════════════════════════════════════════════════════════════════════════

    if (PHASE_FILTER == null || PHASE_FILTER >= 2) {
      console.log('─── Phase 2: Executing regrouping ───\n');

      const targetProductMap = new Map(); // groupKey → target product ID

      for (const [key, group] of regroupPlan) {
        const groupSp = `grp_${++_spCounter}`;
        await client.query(`SAVEPOINT ${groupSp}`);
        try {
          let productName;
          if (group.isAccessory) {
            productName = group.color
              ? `${titleCase(group.collection)} ${titleCase(group.color)} Trim & Accessories`
              : `${titleCase(group.collection)} Trim & Accessories`;
          } else if (group.isCatchall) {
            productName = titleCase(group.collection);
          } else {
            productName = `${titleCase(group.collection)} ${titleCase(group.color)}`;
          }

          // Try to find an existing product to reuse
          const existing = await client.query(
            `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND status = 'active' LIMIT 1`,
            [vendorId, titleCase(group.collection), productName]
          );

          let targetProductId;
          if (existing.rows.length > 0) {
            targetProductId = existing.rows[0].id;
            stats.products_reused++;
          } else {
            // Check if any source product can be reused directly (save a new row)
            const sourceIds = [...group.sourceProductIds];
            let reuseId = null;
            for (const sid of sourceIds) {
              // Only reuse if this product's SKUs all map to this group
              const sSkus = skusByProduct.get(sid) || [];
              const allInGroup = sSkus.every(s => skuNewProduct.get(s.id) === key);
              if (allInGroup) { reuseId = sid; break; }
            }

            if (reuseId) {
              // Rename existing product — use safeTx in case of unique constraint collision
              const renameRes = await safeTx(client, `
                UPDATE products SET name = $2, collection = $3, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
              `, [reuseId, productName, titleCase(group.collection)]);

              if (renameRes) {
                targetProductId = reuseId;
                stats.products_reused++;
              } else {
                // Rename failed (unique constraint) — fall through to create/ON CONFLICT
                reuseId = null;
              }
            }

            if (!reuseId && !targetProductId) {
              // Create new product (or reactivate via ON CONFLICT)
              const newProd = await client.query(`
                INSERT INTO products (vendor_id, name, collection, category_id, status, is_active)
                VALUES ($1, $2, $3, $4, 'active', true)
                ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
                DO UPDATE SET status = 'active', is_active = true, category_id = COALESCE(products.category_id, EXCLUDED.category_id), updated_at = CURRENT_TIMESTAMP
                RETURNING id
              `, [vendorId, productName, titleCase(group.collection), group.categoryId]);
              targetProductId = newProd.rows[0].id;
              stats.products_created++;
            }
          }

          targetProductMap.set(key, targetProductId);

          // Move SKUs
          for (const skuId of group.skuIds) {
            await client.query(
              `UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND product_id IS DISTINCT FROM $1`,
              [targetProductId, skuId]
            );
            stats.skus_moved++;
          }

          await client.query(`RELEASE SAVEPOINT ${groupSp}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${groupSp}`);
          console.error(`  Error processing group "${key}": ${err.message}`);
          stats.errors++;
        }
      }

      console.log(`  Products created: ${stats.products_created}, reused: ${stats.products_reused}`);
      console.log(`  SKUs moved: ${stats.skus_moved}`);

      // ── Move FK references from source products to target products ──
      console.log('  Moving FK references...');

      const sourceToTarget = new Map();
      for (const product of allProducts) {
        const skus = skusByProduct.get(product.id) || [];
        if (skus.length === 0) continue;

        const targetCounts = new Map();
        for (const sku of skus) {
          const gkey = skuNewProduct.get(sku.id);
          if (!gkey) continue;
          const tid = targetProductMap.get(gkey);
          if (!tid) continue;
          targetCounts.set(tid, (targetCounts.get(tid) || 0) + 1);
        }
        if (targetCounts.size === 0) continue;

        let bestTarget = null, bestCount = 0;
        for (const [tid, cnt] of targetCounts) {
          if (cnt > bestCount) { bestTarget = tid; bestCount = cnt; }
        }
        if (bestTarget && bestTarget !== product.id) {
          sourceToTarget.set(product.id, bestTarget);
        }
      }

      const FK_TABLES = [
        { table: 'cart_items', col: 'product_id' },
        { table: 'quote_items', col: 'product_id' },
        { table: 'sample_request_items', col: 'product_id' },
        { table: 'showroom_visit_items', col: 'product_id' },
        { table: 'trade_favorite_items', col: 'product_id' },
        { table: 'estimate_items', col: 'product_id' },
        { table: 'installation_inquiries', col: 'product_id' },
      ];

      for (const [sourceId, targetId] of sourceToTarget) {
        for (const fk of FK_TABLES) {
          const res = await safeTx(client,
            `UPDATE ${fk.table} SET ${fk.col} = $1 WHERE ${fk.col} = $2`,
            [targetId, sourceId]
          );
          if (res) stats.fk_updates += res.rowCount;
        }

        // product_tags
        await safeTx(client, `
          INSERT INTO product_tags (product_id, tag_id)
          SELECT $1, tag_id FROM product_tags WHERE product_id = $2
          ON CONFLICT (product_id, tag_id) DO NOTHING
        `, [targetId, sourceId]);
        await safeTx(client, `DELETE FROM product_tags WHERE product_id = $1`, [sourceId]);

        // wishlists
        await safeTx(client, `
          INSERT INTO wishlists (customer_id, product_id, created_at)
          SELECT customer_id, $1, created_at FROM wishlists WHERE product_id = $2
          ON CONFLICT (customer_id, product_id) DO NOTHING
        `, [targetId, sourceId]);
        await safeTx(client, `DELETE FROM wishlists WHERE product_id = $1`, [sourceId]);

        // product_reviews
        await safeTx(client, `
          INSERT INTO product_reviews (product_id, customer_id, rating, title, body, created_at)
          SELECT $1, customer_id, rating, title, body, created_at FROM product_reviews WHERE product_id = $2
          ON CONFLICT (product_id, customer_id) DO NOTHING
        `, [targetId, sourceId]);
        await safeTx(client, `DELETE FROM product_reviews WHERE product_id = $1`, [sourceId]);

        // Move remaining product-level media
        await safeTx(client, `
          DELETE FROM media_assets m
          WHERE m.product_id = $2 AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $1 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [targetId, sourceId]);

        const maxSortRes = await client.query(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM media_assets WHERE product_id = $1 AND sku_id IS NULL`,
          [targetId]
        );
        let nextSort = parseInt(maxSortRes.rows[0].next_sort) || 0;
        const remaining = await client.query(
          `SELECT id FROM media_assets WHERE product_id = $1 AND sku_id IS NULL ORDER BY sort_order`,
          [sourceId]
        );
        for (const row of remaining.rows) {
          await client.query(
            `UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3`,
            [targetId, nextSort++, row.id]
          );
          stats.media_reparented++;
        }
      }

      console.log(`  FK references moved: ${stats.fk_updates}, Media reparented: ${stats.media_reparented}`);

      // ── Deactivate source products with 0 remaining active SKUs ──
      console.log('  Deactivating empty source products...');

      const targetProductIds = new Set(targetProductMap.values());
      for (const product of allProducts) {
        if (targetProductIds.has(product.id)) continue;

        const remaining = await client.query(
          `SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1 AND status = 'active'`,
          [product.id]
        );

        if (parseInt(remaining.rows[0].cnt) === 0) {
          const orderRefs = await client.query(
            `SELECT COUNT(*) FROM order_items WHERE product_id = $1`,
            [product.id]
          );
          const hasOrders = parseInt(orderRefs.rows[0].count) > 0;

          await client.query(`
            UPDATE products SET status = $2, is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1
          `, [product.id, hasOrders ? 'archived' : 'inactive']);
          stats.products_deactivated++;
        }
      }

      console.log(`  Products deactivated: ${stats.products_deactivated}\n`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 3: Name & Display Name Cleanup
      // ═══════════════════════════════════════════════════════════════════════

      console.log('─── Phase 3: Name & Display Name Cleanup ───\n');

      for (const [key, group] of regroupPlan) {
        const targetId = targetProductMap.get(key);
        if (!targetId) continue;

        let displayName;
        if (group.isAccessory) {
          displayName = group.color
            ? `${titleCase(group.collection)} ${titleCase(group.color)} Trim & Accessories`
            : `${titleCase(group.collection)} Trim & Accessories`;
        } else {
          displayName = titleCase(group.collection);
        }

        const dnRes = await safeTx(client,
          `UPDATE products SET display_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [targetId, displayName]
        );
        if (dnRes) stats.display_names_set++;

        // Set variant_names for SKUs
        for (const skuId of group.skuIds) {
          const skuData = skusRes.rows.find(s => s.id === skuId);
          if (!skuData) continue;

          const skuAttrs = skuAttrsMap.get(skuId) || {};
          const parsed = parsedMap.get(skuData.product_id);

          let variantName;
          if (group.isAccessory) {
            const accType = parsed?.accessoryType || 'Accessory';
            const trimLen = parsed?.trimLength || '';
            variantName = trimLen ? `${accType} ${trimLen}` : accType;
          } else {
            const color = skuAttrs.color || parsed?.color || group.color || '';
            variantName = color ? titleCase(color) : null;
          }

          if (variantName) {
            await client.query(
              `UPDATE skus SET variant_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [skuId, variantName]
            );
            stats.variant_names_updated++;
          }
        }
      }

      console.log(`  Display names set: ${stats.display_names_set}`);
      console.log(`  Variant names updated: ${stats.variant_names_updated}\n`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 4: Attribute Repair
      // ═══════════════════════════════════════════════════════════════════════

      console.log('─── Phase 4: Attribute Repair ───\n');

      for (const sku of skusRes.rows) {
        const parsed = parsedMap.get(sku.product_id);
        if (!parsed) continue;
        const product = allProducts.find(p => p.id === sku.product_id);
        const existing = skuAttrsMap.get(sku.id) || {};

        // Color
        if (parsed.color && attrIds.color && !existing.color) {
          await upsertAttr(client, sku.id, attrIds.color, titleCase(parsed.color));
          stats.attrs_color++;
        }

        // Size — from parsed name or existing
        if (parsed.size && attrIds.size && !existing.size) {
          await upsertAttr(client, sku.id, attrIds.size, parsed.size);
          stats.attrs_size++;
        }

        // Finish
        if (parsed.finish && attrIds.finish && !existing.finish) {
          await upsertAttr(client, sku.id, attrIds.finish, parsed.finish);
          stats.attrs_finish++;
        }

        // Material — derive from category
        if (attrIds.material && !existing.material && product) {
          const material = CATEGORY_MATERIAL_MAP[product.category_name];
          if (material) {
            await upsertAttr(client, sku.id, attrIds.material, material);
            stats.attrs_material++;
          }
        }

        // Thickness — from existing 832 data (already populated by scraper)
        // We don't overwrite, just count
        if (existing.thickness) stats.attrs_thickness++;

        // Pattern (mosaic)
        if (parsed.pattern && attrIds.pattern && !existing.pattern) {
          await upsertAttr(client, sku.id, attrIds.pattern, parsed.pattern);
        }
      }

      console.log(`  Color attrs set:      ${stats.attrs_color}`);
      console.log(`  Size attrs set:       ${stats.attrs_size}`);
      console.log(`  Finish attrs set:     ${stats.attrs_finish}`);
      console.log(`  Material attrs set:   ${stats.attrs_material}`);
      console.log(`  Thickness (existing): ${stats.attrs_thickness}\n`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 5: Image Strategy
      // ═══════════════════════════════════════════════════════════════════════

      console.log('─── Phase 5: Image Strategy ───\n');

      // Tier 1: Inherit best image from merged source products
      console.log('  Tier 1: Inherit best image from merged products...');

      for (const [key, group] of regroupPlan) {
        const targetId = targetProductMap.get(key);
        if (!targetId) continue;

        // Check if target already has an image
        const existingImg = await client.query(
          `SELECT id FROM media_assets WHERE product_id = $1 LIMIT 1`,
          [targetId]
        );
        if (existingImg.rows.length > 0) continue;

        // Find best image from any source product in the group
        let bestImg = null;
        let bestScore = -1;
        for (const sourceId of group.sourceProductIds) {
          const media = mediaByProduct.get(sourceId) || [];
          for (const m of media) {
            if (m.asset_type !== 'primary') continue;
            const score = imageScore(m.url);
            if (score > bestScore) {
              bestScore = score;
              bestImg = m;
            }
          }
        }

        if (bestImg) {
          const imgRes = await safeTx(client, `
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, NULL, 'primary', $2, $2, 0)
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [targetId, bestImg.url]);
          if (imgRes) stats.images_inherited++;
        }
      }

      console.log(`    Inherited: ${stats.images_inherited}`);

      // Tier 2: CDN probing for products still missing images
      console.log('  Tier 2: CDN probing for remaining gaps...');

      const productsWithNoImages = await client.query(`
        SELECT p.id, p.name, p.display_name, p.collection, c.name as category_name
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
        ORDER BY p.display_name
      `, [vendorId]);

      const CDN_BASE = 'https://cdn.msisurfaces.com/images';
      const CDN_SECTIONS = ['porcelainceramic', 'naturalstone', 'hardscaping', 'mosaics', 'lvt', 'colornames'];
      const CDN_TYPES = ['detail', 'front', 'iso'];

      let cdnProbeLimit = Math.min(productsWithNoImages.rows.length, 200); // Limit to avoid excessive network
      let cdnProbed = 0;

      for (const prod of productsWithNoImages.rows.slice(0, cdnProbeLimit)) {
        const baseName = (prod.display_name || prod.name || '').trim();
        if (!baseName || baseName.length < 3) continue;
        if (baseName.startsWith('M S International')) continue;

        const words = baseName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 0);
        if (words.length === 0) continue;

        const slug = words.join('-');
        let found = false;

        for (const section of CDN_SECTIONS) {
          if (found) break;
          for (const type of CDN_TYPES) {
            const url = `${CDN_BASE}/${section}/${type}/${slug}.jpg`;
            const result = await headUrl(url);
            if (result) {
              const cdnRes = await safeTx(client, `
                INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
                VALUES ($1, NULL, 'primary', $2, $2, 0)
                ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
                DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
              `, [prod.id, result]);
              if (cdnRes) { stats.images_cdn_probed++; found = true; }
              break;
            }
          }
        }
        cdnProbed++;
        if (cdnProbed % 50 === 0) {
          console.log(`    CDN probed: ${cdnProbed}/${cdnProbeLimit}, found: ${stats.images_cdn_probed}`);
        }
        if (found) continue;
        await delay(20);
      }

      console.log(`    CDN probed: ${stats.images_cdn_probed}`);

      // Tier 3: Collection sharing — share from same-collection siblings
      console.log('  Tier 3: Collection sharing...');

      const stillMissing = await client.query(`
        SELECT p.id, p.collection, p.display_name
        FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
          AND p.collection IS NOT NULL AND p.collection != '' AND p.collection != 'M S International Inc.'
      `, [vendorId]);

      for (const prod of stillMissing.rows) {
        const { rows: siblings } = await client.query(`
          SELECT ma.url
          FROM products p
          JOIN media_assets ma ON ma.product_id = p.id AND ma.sort_order = 0
          WHERE p.vendor_id = $1 AND p.status = 'active'
            AND p.collection = $2 AND p.id != $3
          ORDER BY
            CASE WHEN ma.url LIKE '/uploads/%' THEN 0 ELSE 1 END
          LIMIT 1
        `, [vendorId, prod.collection, prod.id]);

        if (siblings.length > 0) {
          const shareRes = await safeTx(client, `
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, NULL, 'primary', $2, $2, 0)
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [prod.id, siblings[0].url]);
          if (shareRes) stats.images_collection_shared++;
        }
      }

      console.log(`    Collection shared: ${stats.images_collection_shared}\n`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 6: Category & Status Correction
      // ═══════════════════════════════════════════════════════════════════════

      console.log('─── Phase 6: Category & Status Correction ───\n');

      // Fix uncategorized products using SKU prefixes
      const uncategorized = await client.query(`
        SELECT p.id, p.name, p.collection
        FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id IS NULL
      `, [vendorId]);

      for (const prod of uncategorized.rows) {
        const { rows: skus } = await client.query(
          `SELECT vendor_sku FROM skus WHERE product_id = $1 AND status = 'active' LIMIT 1`,
          [prod.id]
        );
        if (skus.length === 0) continue;

        const vsku = (skus[0].vendor_sku || '').toUpperCase();
        let catSlug = null;

        // Try SKU prefix mapping
        for (const { prefix, slug } of SKU_PREFIX_CATEGORY) {
          if (vsku.startsWith(prefix)) { catSlug = slug; break; }
        }

        // Try name keywords
        if (!catSlug) {
          const nameLower = (prod.name || '').toLowerCase();
          if (/\b(lvp|vinyl|plank)\b/i.test(nameLower)) catSlug = 'luxury-vinyl';
          else if (/\b(mosaic|backsplash)\b/i.test(nameLower)) catSlug = 'mosaic';
          else if (/\b(stacked|ledger|panel)\b/i.test(nameLower)) catSlug = 'stacked-stone';
          else if (/\b(hardscap|paver|outdoor)\b/i.test(nameLower)) catSlug = 'outdoor';
          else if (/\b(porcelain|ceramic|tile)\b/i.test(nameLower)) catSlug = 'tile';
          else if (/\b(marble|granite|travertine|slate|limestone|quartzite|onyx|sandstone)\b/i.test(nameLower)) catSlug = 'natural-stone';
          else if (/\b(quartz|countertop|slab)\b/i.test(nameLower)) catSlug = 'countertops';
          else if (/\b(hardwood|engineered)\b/i.test(nameLower)) catSlug = 'hardwood';
        }

        if (catSlug && catSlugToId[catSlug]) {
          await client.query(
            `UPDATE products SET category_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [prod.id, catSlugToId[catSlug]]
          );
          stats.categories_fixed++;
        }
      }

      console.log(`  Uncategorized fixed: ${stats.categories_fixed}`);

      // Tag accessory SKUs with correct variant_type + sell_by
      for (const [key, group] of regroupPlan) {
        if (!group.isAccessory) continue;
        const targetId = targetProductMap.get(key);
        if (!targetId) continue;

        for (const skuId of group.skuIds) {
          const res = await client.query(`
            UPDATE skus SET variant_type = 'accessory', sell_by = 'unit', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND (variant_type IS DISTINCT FROM 'accessory' OR sell_by IS DISTINCT FROM 'unit')
          `, [skuId]);
          if (res.rowCount > 0) stats.accessory_type_fixed++;
        }
      }
      console.log(`  Accessory SKUs fixed: ${stats.accessory_type_fixed}`);

      // Set collection on products missing it
      const missingColl = await client.query(`
        SELECT p.id, p.name
        FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND (p.collection IS NULL OR p.collection = '' OR p.collection = 'M S International Inc.')
      `, [vendorId]);

      for (const prod of missingColl.rows) {
        const parsed = parsedMap.get(prod.id);
        if (parsed?.collection && parsed.collection !== 'Unknown') {
          const collRes = await safeTx(client,
            `UPDATE products SET collection = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [prod.id, titleCase(parsed.collection)]
          );
          if (collRes) stats.collections_set++;
        }
      }
      console.log(`  Collections set: ${stats.collections_set}`);

      // Fix status inconsistencies (inactive status but is_active=true)
      const statusFix = await client.query(`
        UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE vendor_id = $1 AND is_active = true AND status = 'inactive'
        RETURNING id
      `, [vendorId]);
      stats.status_fixed = statusFix.rowCount;

      // Also fix the reverse: active status but is_active=false
      await client.query(`
        UPDATE products SET is_active = true, updated_at = CURRENT_TIMESTAMP
        WHERE vendor_id = $1 AND status = 'active' AND is_active = false
      `, [vendorId]);

      console.log(`  Status inconsistencies fixed: ${stats.status_fixed}\n`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 7: Description & Search
      // ═══════════════════════════════════════════════════════════════════════

      console.log('─── Phase 7: Description & Search ───\n');

      // Propagate descriptions from source products that had them
      const prodsNeedingDesc = await client.query(`
        SELECT p.id, p.collection
        FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND p.description_long IS NULL AND p.collection IS NOT NULL AND p.collection != ''
      `, [vendorId]);

      for (const prod of prodsNeedingDesc.rows) {
        const { rows: donors } = await client.query(`
          SELECT description_long FROM products
          WHERE vendor_id = $1 AND collection = $2 AND description_long IS NOT NULL AND status = 'active'
          LIMIT 1
        `, [vendorId, prod.collection]);

        if (donors.length > 0) {
          await client.query(
            `UPDATE products SET description_long = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [prod.id, donors[0].description_long]
          );
          stats.descriptions_propagated++;
        }
      }
      console.log(`  Descriptions propagated: ${stats.descriptions_propagated}`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 8: Validation & Search Refresh
      // ═══════════════════════════════════════════════════════════════════════

      console.log('\n─── Phase 8: Validation & Search Refresh ───\n');

      // Deactivate any remaining empty products
      const emptyProducts = await client.query(`
        SELECT p.id, p.name FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM skus WHERE product_id = p.id AND status = 'active')
      `, [vendorId]);

      if (emptyProducts.rows.length > 0) {
        console.log(`  WARNING: ${emptyProducts.rows.length} active products with 0 SKUs — deactivating`);
        for (const p of emptyProducts.rows) {
          await client.query(
            `UPDATE products SET status = 'inactive', is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [p.id]
          );
          stats.products_deactivated++;
        }
      }

      // Refresh search vectors
      console.log('  Refreshing search vectors...');
      const allActiveProds = await client.query(
        `SELECT id FROM products WHERE vendor_id = $1 AND status = 'active'`,
        [vendorId]
      );

      for (const prod of allActiveProds.rows) {
        const svRes = await safeTx(client, 'SELECT refresh_search_vectors($1)', [prod.id]);
        if (svRes) stats.search_vectors_refreshed++;
      }
      console.log(`  Search vectors refreshed: ${stats.search_vectors_refreshed}`);

      // Refresh materialized views
      const mvRes1 = await safeTx(client, 'REFRESH MATERIALIZED VIEW CONCURRENTLY product_popularity');
      console.log(mvRes1 ? '  Refreshed product_popularity view' : '  product_popularity view refresh skipped');

      const mvRes2 = await safeTx(client, 'REFRESH MATERIALIZED VIEW CONCURRENTLY search_vocabulary');
      console.log(mvRes2 ? '  Refreshed search_vocabulary view' : '  search_vocabulary view refresh skipped');
    }

    // ── COMMIT ──
    const commitResult = await client.query('COMMIT');
    if (commitResult.command === 'ROLLBACK') {
      console.error('\nERROR: Transaction was silently ROLLED BACK (aborted state detected).');
      process.exit(1);
    }
    console.log('\nTransaction committed successfully.\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nTransaction ROLLED BACK:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('=== RESULTS ===\n');
  console.log(`  Products created:           ${stats.products_created}`);
  console.log(`  Products reused:            ${stats.products_reused}`);
  console.log(`  Products deactivated:       ${stats.products_deactivated}`);
  console.log(`  SKUs moved:                 ${stats.skus_moved}`);
  console.log(`  Display names set:          ${stats.display_names_set}`);
  console.log(`  Variant names updated:      ${stats.variant_names_updated}`);
  console.log(`  Attrs — color:              ${stats.attrs_color}`);
  console.log(`  Attrs — size:               ${stats.attrs_size}`);
  console.log(`  Attrs — finish:             ${stats.attrs_finish}`);
  console.log(`  Attrs — material:           ${stats.attrs_material}`);
  console.log(`  Attrs — thickness:          ${stats.attrs_thickness}`);
  console.log(`  Images — inherited:         ${stats.images_inherited}`);
  console.log(`  Images — CDN probed:        ${stats.images_cdn_probed}`);
  console.log(`  Images — collection shared: ${stats.images_collection_shared}`);
  console.log(`  Accessory types fixed:      ${stats.accessory_type_fixed}`);
  console.log(`  Categories fixed:           ${stats.categories_fixed}`);
  console.log(`  Collections set:            ${stats.collections_set}`);
  console.log(`  Status fixed:               ${stats.status_fixed}`);
  console.log(`  Descriptions propagated:    ${stats.descriptions_propagated}`);
  console.log(`  Search vectors refreshed:   ${stats.search_vectors_refreshed}`);
  console.log(`  FK references updated:      ${stats.fk_updates}`);
  console.log(`  Media reparented:           ${stats.media_reparented}`);
  if (stats.errors > 0) console.log(`  Errors:                     ${stats.errors}`);
  console.log('');

  // ── After metrics ──
  const afterMetrics = await gatherMetrics(vendorId);
  console.log('=== AFTER ===');
  printMetrics(afterMetrics);

  console.log('\n=== COMPARISON ===');
  console.log(`  Products:           ${beforeMetrics.products} → ${afterMetrics.products}`);
  console.log(`  SKUs:               ${beforeMetrics.skus} → ${afterMetrics.skus}`);
  console.log(`  SKU/product ratio:  ${beforeMetrics.skuRatio} → ${afterMetrics.skuRatio}`);
  console.log(`  Image coverage:     ${beforeMetrics.imageCoverage}% → ${afterMetrics.imageCoverage}%`);
  console.log(`  Collection set:     ${beforeMetrics.collectionCoverage}% → ${afterMetrics.collectionCoverage}%`);
  console.log(`  Color coverage:     ${beforeMetrics.colorCoverage}% → ${afterMetrics.colorCoverage}%`);
  console.log(`  Size coverage:      ${beforeMetrics.sizeCoverage}% → ${afterMetrics.sizeCoverage}%`);
  console.log(`  Finish coverage:    ${beforeMetrics.finishCoverage}% → ${afterMetrics.finishCoverage}%`);
  console.log(`  Material coverage:  ${beforeMetrics.materialCoverage}% → ${afterMetrics.materialCoverage}%`);
  console.log(`  Has display_name:   ${beforeMetrics.displayNameCoverage}% → ${afterMetrics.displayNameCoverage}%`);
  console.log(`  Categorized:        ${beforeMetrics.categorizedPct}% → ${afterMetrics.categorizedPct}%`);
  console.log('');

  await pool.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: upsert a SKU attribute
// ─────────────────────────────────────────────────────────────────────────────

async function upsertAttr(client, skuId, attrId, value) {
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Image scoring helper
// ─────────────────────────────────────────────────────────────────────────────

function imageScore(url) {
  if (!url) return -1;
  const lower = url.toLowerCase();
  // Prefer local uploads over CDN
  if (lower.startsWith('/uploads/')) return 200;
  if (lower.includes('/detail/')) return 100;
  if (lower.includes('/front/')) return 80;
  if (lower.includes('/iso/')) return 60;
  if (lower.includes('/edge/')) return 50;
  if (lower.includes('/vignette/')) return 40;
  if (lower.includes('cdn.msisurfaces.com')) return 30;
  // External CDN
  if (lower.startsWith('https://')) return 20;
  return 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

async function gatherMetrics(vendorId) {
  const [prodRes, skuRes, imgRes, collRes, attrRes, dispRes, catRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = 'active'`, [vendorId]),
    pool.query(`
      SELECT COUNT(*) FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT COUNT(DISTINCT p.id) as with_images, COUNT(DISTINCT p2.id) as total
      FROM products p2
      LEFT JOIN (
        SELECT DISTINCT product_id as id FROM media_assets
      ) p ON p.id = p2.id
      WHERE p2.vendor_id = $1 AND p2.status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE collection IS NOT NULL AND collection != '' AND collection != 'M S International Inc.') as with_coll,
             COUNT(*) as total
      FROM products WHERE vendor_id = $1 AND status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT
        COUNT(DISTINCT s.id) FILTER (WHERE a.slug = 'color' AND sa.value IS NOT NULL) as color_count,
        COUNT(DISTINCT s.id) FILTER (WHERE a.slug = 'size' AND sa.value IS NOT NULL) as size_count,
        COUNT(DISTINCT s.id) FILTER (WHERE a.slug = 'finish' AND sa.value IS NOT NULL) as finish_count,
        COUNT(DISTINCT s.id) FILTER (WHERE a.slug = 'material' AND sa.value IS NOT NULL) as material_count,
        COUNT(DISTINCT s.id) as total
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      LEFT JOIN attributes a ON a.id = sa.attribute_id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE display_name IS NOT NULL AND display_name != '') as with_dn,
             COUNT(*) as total
      FROM products WHERE vendor_id = $1 AND status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE category_id IS NOT NULL) as categorized,
             COUNT(*) as total
      FROM products WHERE vendor_id = $1 AND status = 'active'
    `, [vendorId]),
  ]);

  const products = parseInt(prodRes.rows[0].count);
  const skus = parseInt(skuRes.rows[0].count);
  const withImages = parseInt(imgRes.rows[0].with_images);
  const imgTotal = parseInt(imgRes.rows[0].total) || 1;
  const withColl = parseInt(collRes.rows[0].with_coll);
  const collTotal = parseInt(collRes.rows[0].total) || 1;
  const attrTotal = parseInt(attrRes.rows[0].total) || 1;
  const dispTotal = parseInt(dispRes.rows[0].total) || 1;
  const catTotal = parseInt(catRes.rows[0].total) || 1;

  return {
    products,
    skus,
    skuRatio: products > 0 ? (skus / products).toFixed(1) : '0',
    imageCoverage: ((withImages / imgTotal) * 100).toFixed(1),
    collectionCoverage: ((withColl / collTotal) * 100).toFixed(1),
    colorCoverage: ((parseInt(attrRes.rows[0].color_count) / attrTotal) * 100).toFixed(1),
    sizeCoverage: ((parseInt(attrRes.rows[0].size_count) / attrTotal) * 100).toFixed(1),
    finishCoverage: ((parseInt(attrRes.rows[0].finish_count) / attrTotal) * 100).toFixed(1),
    materialCoverage: ((parseInt(attrRes.rows[0].material_count) / attrTotal) * 100).toFixed(1),
    displayNameCoverage: ((parseInt(dispRes.rows[0].with_dn) / dispTotal) * 100).toFixed(1),
    categorizedPct: ((parseInt(catRes.rows[0].categorized) / catTotal) * 100).toFixed(1),
  };
}

function printMetrics(m) {
  console.log(`  Active products:      ${m.products}`);
  console.log(`  Active SKUs:          ${m.skus}`);
  console.log(`  SKU/product ratio:    ${m.skuRatio}`);
  console.log(`  Image coverage:       ${m.imageCoverage}%`);
  console.log(`  Collection set:       ${m.collectionCoverage}%`);
  console.log(`  Color coverage:       ${m.colorCoverage}%`);
  console.log(`  Size coverage:        ${m.sizeCoverage}%`);
  console.log(`  Finish coverage:      ${m.finishCoverage}%`);
  console.log(`  Material coverage:    ${m.materialCoverage}%`);
  console.log(`  Has display_name:     ${m.displayNameCoverage}%`);
  console.log(`  Categorized:          ${m.categorizedPct}%`);
}

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

// ─────────────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
