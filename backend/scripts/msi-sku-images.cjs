#!/usr/bin/env node
/**
 * MSI Per-SKU Image Assignment
 *
 * Assigns accurate per-SKU images for ALL MSI product categories.
 * CRITICAL: Every image must match the specific SKU. We never assign a
 * wrong-color or wrong-product image.
 *
 * Strategies by category:
 *   1. LVP (Plank):       CDN probe by collection + color name
 *   2. Porcelain Tile:    CDN probe by color + collection, then promote product image
 *   3. Natural Stone:     Promote product image (size variants of same stone)
 *   4. Countertops:       Promote product image (slab sizes)
 *   5. Stacked Stone:     Promote product image (format variants)
 *   6. Hardscaping:       Safe-promote for size-only products; CDN probe for Arterra sub-products
 *   7. Eng. Hardwood:     CDN probe similar to LVP
 *   8. Backsplash/Wall:   Promote product image
 *   9. Accessories:       Inherit parent (main SKU) image
 *
 * Usage:
 *   node backend/scripts/msi-sku-images.cjs --dry-run          # Preview
 *   node backend/scripts/msi-sku-images.cjs                     # Execute
 *   node backend/scripts/msi-sku-images.cjs --category "LVP (Plank)"  # One category
 *   node backend/scripts/msi-sku-images.cjs --verbose           # Extra logging
 */
const { Pool } = require('pg');
const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const catIdx = process.argv.indexOf('--category');
const CATEGORY_FILTER = catIdx !== -1 ? process.argv[catIdx + 1] : null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const CDN = 'https://cdn.msisurfaces.com/images';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(text) {
  return (text || '').toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

function headUrl(url) {
  return new Promise(resolve => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, res => {
      // Consume any data to free the socket
      res.resume();
      done(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

async function probeBatch(urls, concurrency = 15) {
  const results = new Array(urls.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      results[i] = await headUrl(urls[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}

/** Return first hit from a list of candidate URLs */
async function probeFirst(urls, concurrency = 10) {
  // Probe in batches; return first hit
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await probeBatch(batch, concurrency);
    const hit = results.find(r => r !== null);
    if (hit) return hit;
  }
  return null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Vendor SKU decoders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Porcelain vendor_sku color abbreviation → CDN color slug mapping.
 * Vendor SKU format: N{COLL:3}{COLOR:2-5}{SIZE}(-suffix)?
 * e.g., NANTNER6X36 → ANT=Antoni, NER=Nero
 */
const PORCELAIN_COLOR_MAP = {
  'AMB':  ['amber'],
  'ASH':  ['ash'],
  'BIA':  ['bianco'],
  'BLA':  ['blanca', 'blanco'],
  'CAF':  ['cafe'],
  'CAM':  ['camo'],
  'CAR':  ['carbone'],
  'CHA':  ['charcoal'],
  'CON':  ['concrete'],
  'CRE':  ['cremita', 'cream', 'crema'],
  'GLA':  ['glacier'],
  'GRA':  ['graphite'],
  'GRE':  ['greige', 'grey'],
  'GRI':  ['gris', 'grigia', 'grigio'],
  'ICE':  ['ice'],
  'IVO':  ['ivory'],
  'MID':  ['midnight'],
  'MOK':  ['moka'],
  'NER':  ['nero'],
  'ORO':  ['oro'],
  'PEA':  ['pearl'],
  'PLA':  ['platinum'],
  'SAD':  ['saddle'],
  'TAU':  ['taupe'],
  'WAL':  ['walnut'],
  'WEN':  ['wenge'],
  'RED':  ['red'],
  'RUS':  ['rustique'],
  'CRO':  ['criollo'],
  'FOR':  ['forest'],
  'MAR':  ['marble'],
  'OAK':  ['oak'],
  'SAB':  ['sable'],
  'SIE':  ['sienna'],
};

/**
 * Extract color code from Porcelain vendor_sku.
 * Returns the MSI internal color slug or null.
 */
function decodePorcelainColor(vendorSku, collection) {
  if (!vendorSku || !collection) return null;

  // Strip prefix: P-N, NWG, N
  let sku = vendorSku.replace(/^(P-)?N(WG)?/i, '');

  // Find where the size starts (first digit followed by more digits/X)
  const sizeMatch = sku.match(/\d+[X×]/i) || sku.match(/\d{3,}/);
  const sizeIdx = sizeMatch ? sku.indexOf(sizeMatch[0]) : sku.length;
  const prefix = sku.substring(0, sizeIdx);

  // Match collection abbreviation (first 3 chars)
  const collUpper = collection.toUpperCase().replace(/[^A-Z]/g, '');
  for (let len = 4; len >= 2; len--) {
    const abbrev = collUpper.substring(0, len);
    if (prefix.startsWith(abbrev) && prefix.length > len) {
      const colorCode = prefix.substring(len);
      if (colorCode.length >= 2 && colorCode.length <= 6) {
        return colorCode;
      }
    }
  }
  return null;
}

/**
 * Stacked Stone vendor_sku → pattern type decoding.
 * Vendor SKU format: LVEN{M|Q|D|L|X}{COLLECTION_ABBREV}{PATTERN}(-COR)?
 * Pattern suffixes: LED=ledgestone, FLD=fieldstone, ASH=ashlar, SQREC=squares+rectangles
 */
const STACKED_STONE_PATTERNS = {
  'LED': ['ledgestone'],
  'FLD': ['fieldstone', 'veneer-fieldstone'],
  'ASH': ['sawn-ashlar', 'sawn-ashlar-light-tumbled'],
  'ASHTUM': ['sawn-ashlar-light-tumbled', 'sawn-ashlar'],
  'SQREC': ['squares-rectangles', 'sq-and-rec'],
};

function decodeStackedStoneVendorSku(vendorSku) {
  if (!vendorSku) return { pattern: null, isCorner: false };
  const isCorner = vendorSku.endsWith('-COR');
  const clean = vendorSku.replace(/-COR$/, '');

  // Try matching known pattern suffixes at the end
  for (const [code, slugs] of Object.entries(STACKED_STONE_PATTERNS)) {
    if (clean.endsWith(code)) {
      return { pattern: code, slugs, isCorner };
    }
  }
  return { pattern: null, slugs: null, isCorner };
}

/**
 * Engineered Hardwood vendor_sku → sub-product name extraction.
 * Format: VTW{COLORNAME}{SIZE} (planks) or VTT{COLORNAME}-{ACCESSORY} (trims)
 */
function decodeEngHardwoodVendorSku(vendorSku) {
  if (!vendorSku) return null;
  // Plank format: VTW{NAME}{SIZE}
  const plankMatch = vendorSku.match(/^VTW([A-Z]+?)(\d+[.X×]|$)/i);
  if (plankMatch) return plankMatch[1].toLowerCase();
  // Trim format: VTT{NAME}-{TYPE}
  const trimMatch = vendorSku.match(/^VTT([A-Z]+?)-(EC|FSN|FSNL|QR|SR|SRL|RT|ST|T)(-|$)/i);
  if (trimMatch) return trimMatch[1].toLowerCase();
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CDN URL Builders (per category)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LVP / Engineered Hardwood: color-specific plank images
 * Pattern: /lvt/detail/{collection}-{color}-vinyl-flooring.jpg
 */
function buildLvpUrls(collection, variantName, productName) {
  const urls = [];
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);
  const nameSlug = slugify(productName);

  if (!colorSlug) return urls;

  // Primary patterns (most common)
  if (collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/${colorSlug}-${collSlug}-vinyl-flooring.jpg`);
  }
  urls.push(`${CDN}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`);

  // Full product name as slug
  if (nameSlug && nameSlug !== colorSlug) {
    urls.push(`${CDN}/lvt/detail/${nameSlug}-vinyl-flooring.jpg`);
  }

  // Reserve products
  if (/\bres\.?\s/i.test(productName || '')) {
    const noRes = slugify((productName || '').replace(/\bres\.?\s*/i, ''));
    urls.push(`${CDN}/lvt/detail/${noRes}-resrve-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/${noRes}-reserve-vinyl-flooring.jpg`);
  }

  // Colornames fallback
  if (collSlug) {
    urls.push(`${CDN}/colornames/${colorSlug}-${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
  }
  urls.push(`${CDN}/colornames/${colorSlug}.jpg`);
  if (nameSlug && nameSlug !== colorSlug) {
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }

  // ISO view
  if (collSlug) {
    urls.push(`${CDN}/lvt/iso/${collSlug}-${colorSlug}-vinyl-flooring-iso.jpg`);
  }

  // Kelmore-style (no "vinyl-flooring" suffix)
  if (collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`);
  }

  return [...new Set(urls)];
}

/**
 * Engineered Hardwood: sub-product specific images via vendor_sku decoding.
 * CDN paths match LVP patterns: /lvt/detail/{collection}-{subproduct}.jpg
 */
function buildEngHardwoodUrls(collection, vendorSku, variantName, productName) {
  const urls = [];
  const collSlug = slugify(collection);

  // Strategy 1: decode sub-product name from vendor_sku
  const subProduct = decodeEngHardwoodVendorSku(vendorSku);
  if (subProduct && collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${subProduct}.jpg`);
    urls.push(`${CDN}/lvt/iso/${collSlug}-${subProduct}-iso.jpg`);
    urls.push(`${CDN}/lvt/front/${collSlug}-${subProduct}-9.5x86.jpg`);
    urls.push(`${CDN}/lvt/detail/${subProduct}-${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${subProduct}.jpg`);
    urls.push(`${CDN}/colornames/${subProduct}.jpg`);
  }

  // Strategy 2: try LVP-style patterns as fallback
  const colorSlug = slugify(variantName);
  if (colorSlug && collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`);
    urls.push(`${CDN}/lvt/iso/${collSlug}-${colorSlug}-iso.jpg`);
  }

  return [...new Set(urls)];
}

/**
 * Porcelain Tile: color-specific tile images.
 * CDN uses MSI's internal color names (Italian/descriptive), NOT generic colors.
 * We decode the vendor_sku color abbreviation to get the real CDN slug.
 *
 * Confirmed patterns:
 *   /porcelainceramic/iso/{color}-{collection}-porcelain-iso.jpg  (most common)
 *   /porcelainceramic/{color}-{collection}-porcelain.jpg
 *   /porcelainceramic/{color}-{collection}-ceramic.jpg
 *   /porcelainceramic/iso/{collection}-{color}-porcelain-iso.jpg  (some like Aylana)
 *   /colornames/{color}-{collection}.jpg
 */
function buildPorcelainUrls(collection, variantName, productName, displayName, vendorSku) {
  const urls = [];
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);
  const nameSlug = slugify(productName);
  const dispSlug = slugify(displayName);

  if (!collSlug && !nameSlug) return urls;

  // Build collection slug variants:
  // Some collections include a color word (e.g., "Aria Bianco") but CDN uses just "aria"
  const collWords = (collection || '').split(/\s+/);
  const baseCollSlug = collWords.length > 1 ? slugify(collWords[0]) : null;
  const collSlugs = [collSlug, baseCollSlug].filter(Boolean);
  // Deduplicate
  const uniqueCollSlugs = [...new Set(collSlugs)];

  // ── Strategy 1: Decode vendor_sku color code for precise CDN matching ──
  const colorCode = decodePorcelainColor(vendorSku, collection);
  if (colorCode) {
    const mappedColors = PORCELAIN_COLOR_MAP[colorCode] || [];
    // Also try the raw color code lowercased as a slug
    const allColors = [...new Set([...mappedColors, colorCode.toLowerCase()])];

    for (const coll of uniqueCollSlugs) {
      for (const color of allColors) {
        // iso/ patterns (highest quality)
        urls.push(`${CDN}/porcelainceramic/iso/${color}-${coll}-porcelain-iso.jpg`);
        urls.push(`${CDN}/porcelainceramic/iso/${coll}-${color}-porcelain-iso.jpg`);
        // detail patterns
        urls.push(`${CDN}/porcelainceramic/${color}-${coll}-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${color}-${coll}-ceramic.jpg`);
        urls.push(`${CDN}/porcelainceramic/${coll}-${color}-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${coll}-${color}-ceramic.jpg`);
        // Pietra pattern (Bernini series)
        urls.push(`${CDN}/porcelainceramic/${coll}-${color}-pietra-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${color}-${coll}-pietra-porcelain.jpg`);
        // colornames
        urls.push(`${CDN}/colornames/${color}-${coll}.jpg`);
        urls.push(`${CDN}/colornames/${coll}-${color}.jpg`);
      }
    }
  }

  // ── Strategy 2: Use generic variant_name (less specific) ──
  if (colorSlug) {
    // Strip size from colorSlug (e.g., "beige-12x24" → "beige")
    const pureColor = colorSlug.replace(/-?\d+x?\d*$/i, '').replace(/-$/, '');
    for (const coll of uniqueCollSlugs) {
      for (const cs of [pureColor, colorSlug].filter(Boolean)) {
        urls.push(`${CDN}/porcelainceramic/iso/${cs}-${coll}-porcelain-iso.jpg`);
        urls.push(`${CDN}/porcelainceramic/${cs}-${coll}-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${cs}-${coll}-ceramic.jpg`);
        urls.push(`${CDN}/porcelainceramic/iso/${coll}-${cs}-porcelain-iso.jpg`);
        urls.push(`${CDN}/colornames/${cs}-${coll}.jpg`);
        urls.push(`${CDN}/colornames/${coll}-${cs}.jpg`);
      }
    }
  }

  // ── Strategy 3: Extract color from product name ──
  // Product name often contains the MSI color: "Architecta Graphite Black Porcelain Tile"
  if (productName) {
    const cleanName = productName
      .replace(/porcelain\s*tile/i, '')
      .replace(/ceramic\s*tile/i, '')
      .replace(new RegExp(`^${collection}\\s*`, 'i'), '')
      .replace(/\s+(beige|gray|grey|white|ivory|black|charcoal|brown|blue|red|green|gold|cream|taupe|multicolor)\s*$/i, '')
      .trim();
    if (cleanName) {
      const extracted = slugify(cleanName);
      if (extracted && extracted !== colorSlug) {
        for (const coll of uniqueCollSlugs) {
          if (extracted !== coll) {
            urls.push(`${CDN}/porcelainceramic/iso/${extracted}-${coll}-porcelain-iso.jpg`);
            urls.push(`${CDN}/porcelainceramic/${extracted}-${coll}-porcelain.jpg`);
            urls.push(`${CDN}/porcelainceramic/${extracted}-${coll}-ceramic.jpg`);
            urls.push(`${CDN}/colornames/${extracted}-${coll}.jpg`);
          }
        }
        urls.push(`${CDN}/colornames/${extracted}.jpg`);
      }
    }
  }

  // ── Strategy 4: Display name and full product name patterns ──
  if (dispSlug) {
    urls.push(`${CDN}/porcelainceramic/iso/${dispSlug}-porcelain-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${dispSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${dispSlug}.jpg`);
    urls.push(`${CDN}/colornames/${dispSlug}.jpg`);
  }
  if (nameSlug) {
    urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-porcelain-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }

  // ── Strategy 5: Exotika sub-collection pattern ──
  for (const coll of uniqueCollSlugs) {
    urls.push(`${CDN}/porcelainceramic/iso/exotika-${coll}-porcelain-iso.jpg`);
  }

  return [...new Set(urls)];
}

/**
 * Hardscaping: per-sub-product images for Arterra and similar
 * Uses vendor_sku abbreviation decoding
 */

// Known abbreviation → CDN product slug mappings for Arterra
const ARTERRA_ABBREV_MAP = {
  // Beige sub-products
  'CORAVO':  ['cora-vogue'],
  'GRIALM':  ['gritzo-almond'],
  'GRISAL':  ['gritzo-salt'],
  'LIVBEI':  ['livermore-beige'],
  'LIVTRA':  ['livermore-travertine', 'livermore-cream'],
  'LIVCRE':  ['livermore-cream'],
  'PRACRE':  ['praia-cream'],
  'TIEBEI':  ['tierra-beige'],
  'TIEIVO':  ['tierra-ivory'],
  'QUABEI':  ['quarzo-beige', 'quartzite-beige'],
  // Gray sub-products (CDN-verified slugs listed first)
  'ARGTRA':  ['argento-travertino'],
  'BETGRE':  ['beton-grey', 'beton-greige'],
  'CALGRI':  ['caldera-grigio'],
  'CEMSIL':  ['cementique-silver', 'cement-silver', 'cemento-silver'],
  'CEMSILL': ['cementique-silver', 'cement-silver', 'cemento-silver'],
  'LIVPEA':  ['livingstyle-pearl', 'livermore-pearl'],
  'LUCANI':  ['lucas-canitia', 'luca-anice', 'lucerne-anice'],
  'LUCCAN':  ['luca-canapa', 'lucerne-canapa'],
  'LUNSIL':  ['luna-silver'],
  'PRAGRE':  ['praia-greige'],
  'QUAGRA':  ['quarzo-gray', 'quartzite-gray'],
  'TERGRI':  ['terrazo-gris', 'terenzo-grigio'],
  'TRESIL':  ['trento-silver', 'tre-silver'],
  'VORSIL':  ['vortex-silver'],
  'VULGRE':  ['vulcano-greige'],
  'ATLGRI':  ['atlas-grigio'],
  'SORGRI':  ['soreno-grigio'],
  // Charcoal sub-products
  'BETANT':  ['beton-antracite'],
  'CEMGRA':  ['cement-gray', 'cemento-gray'],
  'VORCHA':  ['vortex-charcoal'],
  // Black sub-products
  'MIDMON':  ['midnight-montage'],
  'VULNER':  ['vulcano-nero'],
  // White sub-products
  'BETBLA':  ['beton-blanco'],
  'CALBLA':  ['caldera-blanca'],
  'GRISLT':  ['gritzo-salt'],
  'LIVWHI':  ['livermore-white'],
  'PRAGRI':  ['praia-grigio'],
  'QUAWHI':  ['quarzo-white'],
  'TIEWHI':  ['tierra-white'],
  'TREWHI':  ['trento-white'],
  'VORWHI':  ['vortex-white'],
  // Ivory sub-products
  'PRAIVO':  ['praia-ivory'],
  'CALGRI':  ['caldera-grigio'],
  'SORTAU':  ['soreno-taupe'],
  // Brown sub-products
  'FAUNA':   ['fauna'],
  'LUCBET':  ['luca-betra', 'lucerne-betra'],
  // Taupe sub-products
  'SORTAU':  ['soreno-taupe'],
  // Ivory sub-products
  'SORIVO':  ['soreno-ivory'],
  'VORIVO':  ['vortex-ivory'],
  'CEMTAL':  ['cemento-talco', 'cemento-taupe'],
  'CORLABLA': ['cora-la-blanca', 'coral-blanca'],
  'FOSSNO':  ['fossil-snow'],
  // Arterra (base collection)
  'TAJIVO':  ['legions-taj-ivory', 'taj-ivory'],
  // Other collections
  'MOUBLU':  ['mountain-bluestone'],
  'FOSBEI':  ['fossil-beige'],
  'NOVGRY':  ['nova-gray'],
  'MAYWHI':  ['mayra-white'],
  'SIEWHI':  ['sierra-white'],
  'ZEMNAC':  ['zementi-natural'],
  'MIDMST':  ['midnight-mist'],
};

function parseArterraVendorSku(vendorSku) {
  // Pattern: L{TYPE}N{ABBREV}{SIZE}(-{SUFFIX})?
  // LCOP = coping, LPAV = paver, LCAP = cap
  // Examples: LCOPNGRIALM1324-EE → GRIALM, LPAVNLIVBEI2424 → LIVBEI
  const m = vendorSku.match(/^L(?:COP|PAV|CAP)[A-Z]([A-Z]{3,8})(\d{3,}|PAT)/i);
  if (!m) return null;
  return m[1].toUpperCase();
}

function buildHardscapingSubProductUrls(vendorSku, collection, variantName) {
  const urls = [];
  const collSlug = slugify(collection);

  // Try to extract sub-product abbreviation
  const abbrev = parseArterraVendorSku(vendorSku);
  if (abbrev && ARTERRA_ABBREV_MAP[abbrev]) {
    const names = ARTERRA_ABBREV_MAP[abbrev];
    for (const name of names) {
      // Try different suffixes based on vendor_sku prefix
      const isCoping = vendorSku.startsWith('LCOP');
      const isPaver = vendorSku.startsWith('LPAV');

      if (isCoping) {
        urls.push(`${CDN}/hardscaping/detail/${name}-arterra-porcelain-copings.jpg`);
        urls.push(`${CDN}/hardscaping/detail/${name}-arterra-porcelain-copings-c.jpg`);
        urls.push(`${CDN}/hardscaping/detail/${name}-${collSlug}-porcelain-copings.jpg`);
        urls.push(`${CDN}/porcelainceramic/${name}-arterra-porcelain-copings.jpg`);
        urls.push(`${CDN}/skus/detail/${name}-arterra-porcelain-copings-c.jpg`);
      }
      if (isPaver) {
        urls.push(`${CDN}/hardscaping/detail/${name}-arterra-pavers-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${name}-arterra-pavers-porcelain.jpg`);
        urls.push(`${CDN}/hardscaping/detail/${name}-${collSlug}-pavers-porcelain.jpg`);
      }
      // Pool coping pattern
      urls.push(`${CDN}/hardscaping/detail/${name}-arterra-pool-coping.jpg`);
      // Legions- prefix pattern
      urls.push(`${CDN}/hardscaping/detail/legions-${name}-arterra-pavers-porcelain.jpg`);
      urls.push(`${CDN}/hardscaping/detail/legions-${name}-arterra-porcelain-copings.jpg`);
      // porcelainceramic iso path
      urls.push(`${CDN}/porcelainceramic/iso/${name}-arterra-pavers-porcelain-iso.jpg`);
      // Generic
      urls.push(`${CDN}/hardscaping/detail/${name}-${collSlug}-porcelain.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${name}-${collSlug}.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${name}.jpg`);
      urls.push(`${CDN}/colornames/${name}.jpg`);

      // Size-specific patterns
      const sizeMatch = vendorSku.match(/(\d{2})(\d{2})(?:-|$)/);
      if (sizeMatch) {
        const size = `${sizeMatch[1]}x${sizeMatch[2]}`;
        if (isCoping) {
          urls.push(`${CDN}/hardscaping/detail/${name}-arterra-porcelain-copings-${size}.jpg`);
        }
        if (isPaver) {
          urls.push(`${CDN}/hardscaping/detail/${name}-arterra-pavers-porcelain-${size}.jpg`);
        }
      }
    }
  }

  return [...new Set(urls)];
}

/**
 * Stacked Stone images — pattern-type aware.
 * Vendor SKUs encode the stone pattern (LED=ledgestone, FLD=fieldstone, etc.)
 * Each pattern looks visually different, so we must match the correct one.
 *
 * Collections: Rockmount (natural stone), Terrado (manufactured), Avalon Bay, Bedford, etc.
 */
function buildStackedStoneUrls(productName, collection, vendorSku) {
  const urls = [];
  const collSlug = slugify(collection);

  // Strip prefixes: "Rockmount ", "XL Rockmount ", "Terrado "
  // Strip trailing color words (CDN uses stone name without generic color)
  const cleanName = productName
    .replace(/^(?:XL\s+)?Rockmount\s+/i, '')
    .replace(/^Terrado\s+/i, '')
    .replace(/\s+Trim\s*&\s*Accessories$/i, '')
    .replace(/\s+(Gray|Grey|Brown|Black|White|Beige|Ivory|Charcoal|Multicolor|Blue|Green|Gold|Orange|Peach|Red)\s*$/i, '');
  const cleanSlug = slugify(cleanName);
  // Also build a slug with the color for patterns that include it (e.g., bedford-brown-sq-and-rec)
  const nameWithColor = productName
    .replace(/^(?:XL\s+)?Rockmount\s+/i, '')
    .replace(/^Terrado\s+/i, '')
    .replace(/\s+Trim\s*&\s*Accessories$/i, '');
  const withColorSlug = slugify(nameWithColor);

  // Decode pattern type from vendor_sku
  const { slugs: patternSlugs, isCorner } = decodeStackedStoneVendorSku(vendorSku);

  if (cleanSlug) {
    if (patternSlugs) {
      // ── Pattern-specific URLs (most accurate) ──
      for (const pat of patternSlugs) {
        if (isCorner) {
          urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-${pat}-corner.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-${pat}-corner-size.jpg`);
          urls.push(`${CDN}/hardscaping/variations/${cleanSlug}-${pat}-var-corner.jpg`);
          urls.push(`${CDN}/hardscaping/variations/${cleanSlug}-stacked-stone-panels-corner2.jpg`);
          urls.push(`${CDN}/hardscaping/variations/${cleanSlug}-${pat}-corner2.jpg`);
        } else {
          urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-${pat}.jpg`);
          urls.push(`${CDN}/hardscaping/iso/${cleanSlug}-${pat}-iso.jpg`);
          urls.push(`${CDN}/hardscaping/edge/${cleanSlug}-${pat}-edge.jpg`);
          urls.push(`${CDN}/hardscaping/variations/${cleanSlug}-${pat}-variation.jpg`);
        }
      }
      // Also try with-color slug (e.g., bedford-brown-sq-and-rec)
      if (withColorSlug !== cleanSlug) {
        for (const pat of patternSlugs) {
          if (isCorner) {
            urls.push(`${CDN}/hardscaping/detail/${withColorSlug}-${pat}-corner.jpg`);
          } else {
            urls.push(`${CDN}/hardscaping/detail/${withColorSlug}-${pat}.jpg`);
            urls.push(`${CDN}/hardscaping/iso/${withColorSlug}-${pat}-iso.jpg`);
          }
        }
      }
    } else {
      // ── No pattern type decoded — try generic patterns ──
      for (const slug of [cleanSlug, withColorSlug !== cleanSlug ? withColorSlug : null].filter(Boolean)) {
        if (isCorner) {
          urls.push(`${CDN}/hardscaping/variations/${slug}-stacked-stone-panels-corner2.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-stacked-stone-panels-6x12x6-corner.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-stacked-stone-panels-corner.jpg`);
        } else {
          urls.push(`${CDN}/hardscaping/detail/${slug}-stacked-stone-panels.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-3d-honed-stacked-stone-panels.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-3d-wave-stacked-stone-panels.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-wave-stacked-stone-panels-6x18.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-ledgestone.jpg`);
          urls.push(`${CDN}/hardscaping/detail/${slug}-fieldstone.jpg`);
          urls.push(`${CDN}/hardscaping/iso/${slug}-stacked-stone-panels-iso.jpg`);
        }
      }
    }

    // Terrado-specific patterns
    if (/^Terrado\b/i.test(productName)) {
      const terradoClean = cleanSlug;
      urls.push(`${CDN}/hardscaping/detail/${terradoClean}-terrado-stacked-stone-panels.jpg`);
      urls.push(`${CDN}/hardscaping/iso/${terradoClean}-terrado-stacked-stone-panels-iso.jpg`);
      // Some Terrado products use just the name (e.g., cottonwood-white, danbury-white)
      urls.push(`${CDN}/hardscaping/detail/${terradoClean}.jpg`);
      urls.push(`${CDN}/hardscaping/iso/${terradoClean}-iso.jpg`);
      urls.push(`${CDN}/hardscaping/edge/${terradoClean}-edge.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${terradoClean}-ioc.jpg`);
    }

    // XL Rockmount patterns
    if (/^XL Rockmount\b/i.test(productName)) {
      urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-xlrockmount-panels-9x18-corner.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-xl-rockmount-stacked-stone-panels.jpg`);
    }

    // Colornames fallback
    urls.push(`${CDN}/colornames/${cleanSlug}.jpg`);
  }

  return [...new Set(urls)];
}

/**
 * General hardscaping (non-Arterra) images
 */
function buildHardscapingUrls(productName, collection, variantName) {
  const urls = [];
  const nameSlug = slugify(productName);
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);

  if (nameSlug) {
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}.jpg`);
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}-pavers.jpg`);
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}-porcelain.jpg`);
    urls.push(`${CDN}/hardscaping/${nameSlug}.jpg`);
  }
  if (collSlug && colorSlug) {
    urls.push(`${CDN}/hardscaping/detail/${collSlug}-${colorSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
  }
  if (collSlug) {
    urls.push(`${CDN}/hardscaping/detail/${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}.jpg`);
  }

  return [...new Set(urls)];
}

/**
 * Natural stone / countertop images.
 * CDN REQUIRES material suffix for colornames/:
 *   granite → colornames/{slug}-granite.jpg
 *   marble  → colornames/{slug}-marble.jpg
 *   quartzite → colornames/{slug}-quartzite.jpg
 *   quartz → quartz-countertops/products/slab/large/{slug}-quartz.jpg
 *   soapstone → colornames/{slug}-soapstone.jpg
 */
function buildNaturalStoneUrls(productName, collection, displayName, category) {
  const urls = [];
  const nameSlug = slugify(productName);
  const collSlug = slugify(collection);
  const dispSlug = slugify(displayName);

  // Determine material suffix from category
  const materialSuffixes = [];
  if (category) {
    const cat = category.toLowerCase();
    if (cat.includes('granite')) materialSuffixes.push('granite');
    else if (cat.includes('marble')) materialSuffixes.push('marble');
    else if (cat.includes('quartzite')) materialSuffixes.push('quartzite');
    else if (cat.includes('quartz')) materialSuffixes.push('quartz');
    else if (cat.includes('soapstone')) materialSuffixes.push('soapstone');
    else {
      // Natural Stone generic — try all common suffixes
      materialSuffixes.push('granite', 'marble', 'quartzite');
    }
  } else {
    materialSuffixes.push('granite', 'marble', 'quartzite');
  }

  const isQuartz = materialSuffixes.includes('quartz');

  for (const slug of [dispSlug, nameSlug, collSlug].filter(Boolean)) {
    // colornames with material suffix (REQUIRED — without suffix returns 404)
    for (const suffix of materialSuffixes) {
      urls.push(`${CDN}/colornames/${slug}-${suffix}.jpg`);
    }

    // Quartz has its own CDN path structure
    if (isQuartz) {
      urls.push(`${CDN}/quartz-countertops/products/slab/large/${slug}-quartz.jpg`);
      urls.push(`${CDN}/quartz-countertops/products/closeup/large/${slug}-quartz.jpg`);
    }

    // natural-stone path variants
    urls.push(`${CDN}/natural-stone/detail/${slug}.jpg`);
    urls.push(`${CDN}/naturalstone/detail/${slug}.jpg`);
    urls.push(`${CDN}/naturalstone/${slug}.jpg`);

    // Also try without suffix as last resort (some older products)
    urls.push(`${CDN}/colornames/${slug}.jpg`);
  }

  return [...new Set(urls)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories that are safe to promote product image → SKU
// (SKUs are size/format variants that look identical)
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_PROMOTE_CATEGORIES = new Set([
  'Porcelain Tile',
  'Natural Stone',
  'Granite Countertops',
  'Quartzite Countertops',
  'Marble Countertops',
  'Quartz Countertops',
  'Vanity Tops',
  'Backsplash Tile',
  'Backsplash & Wall Tile',
  'Surface Prep & Levelers',
  'Adhesives & Sealants',
  'Pavers',
  'Waterproof Wood',
  'Transitions & Moldings',
]);

/**
 * Check if a mosaic product has multiple distinct patterns among its SKUs.
 * If yes, promoting a single product image to all SKUs would show the WRONG
 * pattern for most SKUs — e.g., showing a hexagon image for a chevron SKU.
 */
function mosaicHasMultiplePatterns(skus) {
  // Extract pattern suffixes from SMOT vendor_skus
  const patterns = new Set();
  for (const s of skus) {
    if (s.variant_type === 'accessory') continue;
    const sku = s.vendor_sku || '';
    // SMOT-{COLLECTION}-{SUFFIX} → suffix indicates pattern
    const parts = sku.split('-');
    if (parts[0] === 'SMOT' && parts.length >= 3) {
      // Suffix = everything after SMOT-COLLECTION-
      const suffix = parts.slice(2).join('-').replace(/\d+MM$/i, '').replace(/\d+X\d+/gi, '').toUpperCase();
      if (suffix) patterns.add(suffix);
    }
  }
  return patterns.size > 1;
}

// Hardscaping products that are safe to promote (size-only variants).
// Each Arterra color (Beige, Gray, Charcoal, etc.) is its own product,
// and all SKUs within it are just size/format variants (pavers, copers, caps).
function isHardscapingSafeToPromote(productName, skuCount, mainSkus) {
  // If all non-accessory SKUs share the same variant_name (color), it's safe
  if (mainSkus && mainSkus.length > 0) {
    const colors = new Set(mainSkus.map(s => (s.variant_name || '').toLowerCase()));
    if (colors.size <= 1) return true;
  }
  // Small products are always safe
  if (skuCount <= 5) return true;
  // Arterra with many SKUs: safe if product name includes a single color
  // (e.g., "Arterra Gray" is one color, "Arterra" alone might be multi-color)
  if (/^Arterra\s+\w+/i.test(productName)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMSI Per-SKU Image Assignment${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (CATEGORY_FILTER) console.log(`Category filter: "${CATEGORY_FILTER}"`);
  console.log('='.repeat(65) + '\n');

  const client = await pool.connect();

  try {
    // 1. Get MSI vendor
    const { rows: [vendor] } = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    if (!vendor) { console.log('ERROR: MSI vendor not found'); return; }

    // 2. Get ALL MSI products with their category and image info
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.display_name, p.collection, c.name as category
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.status = 'active'
        ${CATEGORY_FILTER ? "AND c.name = $2" : ""}
      ORDER BY c.name, p.collection, p.name
    `, CATEGORY_FILTER ? [vendor.id, CATEGORY_FILTER] : [vendor.id]);

    console.log(`Found ${products.length} active MSI products\n`);

    // 3. Get ALL active SKUs for these products
    const productIds = products.map(p => p.id);
    const { rows: allSkus } = await client.query(`
      SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type, s.status
      FROM skus s
      WHERE s.product_id = ANY($1) AND s.status = 'active'
      ORDER BY s.vendor_sku
    `, [productIds]);

    // Group SKUs by product
    const skusByProduct = new Map();
    for (const s of allSkus) {
      if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
      skusByProduct.get(s.product_id).push(s);
    }

    // 4. Get existing SKU-level images (to skip already-covered SKUs)
    const { rows: existingSkuMedia } = await client.query(`
      SELECT DISTINCT ma.sku_id
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      WHERE s.product_id = ANY($1)
    `, [productIds]);
    const skusWithImages = new Set(existingSkuMedia.map(r => r.sku_id));

    // 5. Get product-level primary images
    const { rows: productMedia } = await client.query(`
      SELECT ma.product_id, ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma
      WHERE ma.product_id = ANY($1) AND ma.sku_id IS NULL
        AND ma.asset_type IN ('primary', 'alternate')
      ORDER BY ma.sort_order
    `, [productIds]);

    const productImageMap = new Map();
    for (const m of productMedia) {
      if (!productImageMap.has(m.product_id)) productImageMap.set(m.product_id, []);
      productImageMap.get(m.product_id).push(m);
    }

    // 6. Process each product
    const stats = {
      total_skus: 0,
      already_have_images: 0,
      promoted: 0,       // product image → SKU
      cdn_matched: 0,    // CDN probe found specific image
      parent_inherited: 0, // accessory inherited from parent
      skipped_no_source: 0, // no image source found
      skipped_unsafe: 0,   // not safe to promote (multi-variant)
    };
    const inserts = []; // { skuId, productId, url, assetType, sortOrder }
    const categoryStats = {};

    for (const product of products) {
      const skus = skusByProduct.get(product.id) || [];
      if (skus.length === 0) continue;

      const category = product.category || 'Unknown';
      if (!categoryStats[category]) {
        categoryStats[category] = { total: 0, covered: 0, promoted: 0, cdn: 0, inherited: 0, skipped: 0 };
      }

      const productImages = productImageMap.get(product.id) || [];
      const primaryImg = productImages.find(m => m.asset_type === 'primary' && m.sort_order === 0);

      // Find the main (non-accessory) SKUs
      const mainSkus = skus.filter(s => !s.variant_type || s.variant_type === '');
      const accSkus = skus.filter(s => s.variant_type === 'accessory');

      for (const sku of skus) {
        stats.total_skus++;
        categoryStats[category].total++;

        // Skip if already has SKU-level image
        if (skusWithImages.has(sku.id)) {
          stats.already_have_images++;
          categoryStats[category].covered++;
          continue;
        }

        const isAccessory = sku.variant_type === 'accessory';
        let imageUrl = null;
        let source = null;

        // ── Strategy: CDN-ONLY per-SKU matching ──
        // Only assign images verified via CDN HEAD probe to match this specific SKU.
        // NEVER promote generic product-level images to SKUs.

        if (isAccessory) {
          // ACCESSORIES: inherit from COLOR-MATCHED parent SKU's image.
          // Must match by sub-product/color key to avoid cross-color inheritance.

          // Determine this accessory's color key for matching
          let accColorKey = null;
          if (category === 'Engineered Hardwood') {
            accColorKey = decodeEngHardwoodVendorSku(sku.vendor_sku);
          } else if (['Porcelain Tile', 'Large Format Tile'].includes(category)) {
            accColorKey = decodePorcelainColor(sku.vendor_sku, product.collection);
          } else if (category === 'LVP (Plank)' || category === 'Waterproof Wood') {
            accColorKey = slugify(sku.variant_name);
          }

          // Find color-matched parent SKUs (or all parents if no color key)
          const matchedParents = accColorKey
            ? mainSkus.filter(ms => {
                let parentKey;
                if (category === 'Engineered Hardwood') parentKey = decodeEngHardwoodVendorSku(ms.vendor_sku);
                else if (['Porcelain Tile', 'Large Format Tile'].includes(category)) parentKey = decodePorcelainColor(ms.vendor_sku, product.collection);
                else if (category === 'LVP (Plank)' || category === 'Waterproof Wood') parentKey = slugify(ms.variant_name);
                return parentKey === accColorKey;
              })
            : mainSkus;

          // Check DB first for pre-existing parent images (color-matched)
          const parentWithImg = matchedParents.find(ms => skusWithImages.has(ms.id));
          if (parentWithImg) {
            const { rows: parentImgs } = await client.query(
              `SELECT url FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' LIMIT 1`,
              [parentWithImg.id]
            );
            if (parentImgs.length > 0) {
              imageUrl = parentImgs[0].url;
              source = 'parent_sku';
            }
          }
          // Also check inserts from current run (color-matched parent)
          if (!imageUrl) {
            const parentInsert = inserts.find(i => matchedParents.some(ms => ms.id === i.skuId));
            if (parentInsert) {
              imageUrl = parentInsert.url;
              source = 'parent_sku';
            }
          }
          // If no parent SKU image, try CDN probe for the accessory's own color
          if (!imageUrl) {
            const parentColor = matchedParents[0]?.variant_name || sku.variant_name;
            const parentVsku = matchedParents[0]?.vendor_sku || sku.vendor_sku;
            let candidates;
            if (category === 'LVP (Plank)' || category === 'Waterproof Wood' || category === 'Engineered Hardwood') {
              candidates = buildLvpUrls(product.collection, parentColor, product.name);
              // For Eng Hardwood, also try sub-product-specific URLs
              if (category === 'Engineered Hardwood') {
                candidates = [...buildEngHardwoodUrls(product.collection, parentVsku, parentColor, product.name), ...candidates];
              }
            } else if (category === 'Porcelain Tile') {
              candidates = buildPorcelainUrls(product.collection, parentColor, product.name, product.display_name, parentVsku);
            } else if (category === 'Stacked Stone') {
              candidates = buildStackedStoneUrls(product.name, product.collection, parentVsku);
            } else {
              candidates = buildLvpUrls(product.collection, parentColor, product.name);
            }
            if (candidates && candidates.length > 0) {
              imageUrl = await probeFirst(candidates, 8);
              if (imageUrl) source = 'cdn_probe';
            }
          }

        } else if (category === 'LVP (Plank)' || category === 'Waterproof Wood') {
          // LVP: CDN probe by collection + variant (color) name
          const candidates = buildLvpUrls(product.collection, sku.variant_name, product.name);
          if (candidates.length > 0) {
            imageUrl = await probeFirst(candidates);
            if (imageUrl) source = 'cdn_probe';
          }

        } else if (category === 'Engineered Hardwood') {
          // ENG HARDWOOD: vendor_sku-based sub-product name extraction
          const candidates = buildEngHardwoodUrls(
            product.collection, sku.vendor_sku, sku.variant_name, product.name
          );
          if (candidates.length > 0) {
            imageUrl = await probeFirst(candidates, 8);
            if (imageUrl) source = 'cdn_probe';
          }

        } else if (category === 'Porcelain Tile' || category === 'Large Format Tile') {
          // PORCELAIN: vendor_sku color decoding + CDN probe
          const candidates = buildPorcelainUrls(
            product.collection, sku.variant_name, product.name, product.display_name, sku.vendor_sku
          );
          if (candidates.length > 0) {
            imageUrl = await probeFirst(candidates, 8);
            if (imageUrl) source = 'cdn_probe';
          }

        } else if (category === 'Stacked Stone') {
          // STACKED STONE: pattern-type aware CDN probe
          const candidates = buildStackedStoneUrls(product.name, product.collection, sku.vendor_sku);
          if (candidates.length > 0) {
            imageUrl = await probeFirst(candidates, 8);
            if (imageUrl) source = 'cdn_probe';
          }

        } else if (category === 'Hardscaping') {
          // HARDSCAPING: CDN probe per vendor_sku
          const isArterra = /^Arterra\b/i.test(product.name);
          if (isArterra && skus.length > 5) {
            // Multi-sub-product Arterra: CDN probe with abbreviation decode
            const candidates = buildHardscapingSubProductUrls(
              sku.vendor_sku, product.collection, sku.variant_name
            );
            if (candidates.length > 0) {
              imageUrl = await probeFirst(candidates, 8);
              if (imageUrl) source = 'cdn_probe';
            }
          } else {
            // Non-Arterra hardscaping: CDN probe by product name
            const candidates = buildHardscapingUrls(product.name, product.collection, sku.variant_name);
            if (candidates.length > 0) {
              imageUrl = await probeFirst(candidates, 8);
              if (imageUrl) source = 'cdn_probe';
            }
          }

        } else if (category === 'Mosaic Tile') {
          // MOSAIC: skip — use the dedicated msi-mosaic-sku-images.cjs script
          stats.skipped_no_source++;
          categoryStats[category].skipped++;
          continue;

        } else if (['Natural Stone', 'Granite Countertops', 'Quartzite Countertops',
                     'Marble Countertops', 'Quartz Countertops'].includes(category)) {
          // NATURAL STONE / COUNTERTOPS: CDN probe only
          const candidates = buildNaturalStoneUrls(product.name, product.collection, product.display_name, category);
          if (candidates.length > 0) {
            imageUrl = await probeFirst(candidates, 8);
            if (imageUrl) source = 'cdn_probe';
          }

        } else {
          // ALL OTHER CATEGORIES: CDN probe using product name as best guess
          const candidates = [
            ...buildPorcelainUrls(product.collection, sku.variant_name, product.name, product.display_name),
            ...buildNaturalStoneUrls(product.name, product.collection, product.display_name, category),
          ];
          if (candidates.length > 0) {
            imageUrl = await probeFirst(candidates, 8);
            if (imageUrl) source = 'cdn_probe';
          }
        }

        // Record the insert
        if (imageUrl) {
          inserts.push({
            skuId: sku.id,
            productId: product.id,
            url: imageUrl,
            assetType: 'primary',
            sortOrder: 0,
          });

          if (source === 'cdn_probe') {
            stats.cdn_matched++;
            categoryStats[category].cdn++;
          } else if (source === 'parent_sku') {
            stats.parent_inherited++;
            categoryStats[category].inherited++;
          }

          if (VERBOSE) {
            const short = imageUrl.replace('https://cdn.msisurfaces.com/images/', 'CDN:').replace(/\/uploads\/products\/[^/]+\//, '/uploads/…/');
            console.log(`  ✓ ${sku.vendor_sku} [${category}] ← ${source}: ${short}`);
          }
        } else {
          stats.skipped_no_source++;
          categoryStats[category].skipped++;
          if (VERBOSE) {
            console.log(`  ✗ ${sku.vendor_sku} [${category}] — no image source found`);
          }
        }
      }
    }

    // ── Phase 2: Same-color sibling inheritance ──
    // For each product, if one SKU of a given color got a CDN hit,
    // other SKUs of the same color (different sizes) can inherit that image.
    // This is safe because different sizes of the same tile look identical.
    const insertedSkuIds = new Set(inserts.map(i => i.skuId));
    let siblingCount = 0;

    for (const product of products) {
      const skus = skusByProduct.get(product.id) || [];
      if (skus.length <= 1) continue;
      const category = product.category || 'Unknown';

      // Build a map: color code → CDN-matched URL
      const colorUrlMap = new Map();
      for (const ins of inserts) {
        if (ins.productId !== product.id) continue;
        const matchedSku = skus.find(s => s.id === ins.skuId);
        if (!matchedSku) continue;

        // Decode color key from vendor_sku (category-specific)
        let colorKey;
        if (['Porcelain Tile', 'Large Format Tile'].includes(category)) {
          colorKey = decodePorcelainColor(matchedSku.vendor_sku, product.collection);
        } else if (category === 'Engineered Hardwood') {
          colorKey = decodeEngHardwoodVendorSku(matchedSku.vendor_sku);
        } else if (category === 'LVP (Plank)' || category === 'Waterproof Wood') {
          // For LVP, use variant_name as color key (e.g., "Bracken Hill")
          colorKey = slugify(matchedSku.variant_name);
        } else if (category === 'Stacked Stone') {
          // For Stacked Stone, use pattern type as key
          const { pattern } = decodeStackedStoneVendorSku(matchedSku.vendor_sku);
          colorKey = pattern;
        }
        if (colorKey && !colorUrlMap.has(colorKey)) {
          colorUrlMap.set(colorKey, ins.url);
        }
      }

      // Also check pre-existing SKU images for color keys (from previous runs)
      for (const sku of skus) {
        if (!skusWithImages.has(sku.id)) continue;
        let colorKey;
        if (['Porcelain Tile', 'Large Format Tile'].includes(category)) {
          colorKey = decodePorcelainColor(sku.vendor_sku, product.collection);
        } else if (category === 'Engineered Hardwood') {
          colorKey = decodeEngHardwoodVendorSku(sku.vendor_sku);
        } else if (category === 'LVP (Plank)' || category === 'Waterproof Wood') {
          colorKey = slugify(sku.variant_name);
        } else if (category === 'Stacked Stone') {
          const { pattern } = decodeStackedStoneVendorSku(sku.vendor_sku);
          colorKey = pattern;
        }
        if (colorKey && !colorUrlMap.has(colorKey)) {
          // Check current inserts first, then query DB for pre-existing images
          const existing = inserts.find(i => i.skuId === sku.id);
          if (existing) {
            colorUrlMap.set(colorKey, existing.url);
          } else {
            const { rows: dbImgs } = await client.query(
              `SELECT url FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' LIMIT 1`,
              [sku.id]
            );
            if (dbImgs.length > 0) colorUrlMap.set(colorKey, dbImgs[0].url);
          }
        }
      }

      if (colorUrlMap.size === 0) continue;

      // Assign to unmatched siblings with the same color key
      for (const sku of skus) {
        if (skusWithImages.has(sku.id) || insertedSkuIds.has(sku.id)) continue;

        let colorKey;
        if (['Porcelain Tile', 'Large Format Tile'].includes(category)) {
          colorKey = decodePorcelainColor(sku.vendor_sku, product.collection);
        } else if (category === 'Engineered Hardwood') {
          colorKey = decodeEngHardwoodVendorSku(sku.vendor_sku);
        } else if (category === 'LVP (Plank)' || category === 'Waterproof Wood') {
          colorKey = slugify(sku.variant_name);
        } else if (category === 'Stacked Stone') {
          const { pattern } = decodeStackedStoneVendorSku(sku.vendor_sku);
          colorKey = pattern;
        }

        if (colorKey && colorUrlMap.has(colorKey)) {
          inserts.push({
            skuId: sku.id,
            productId: product.id,
            url: colorUrlMap.get(colorKey),
            assetType: 'primary',
            sortOrder: 0,
          });
          insertedSkuIds.add(sku.id);
          stats.parent_inherited++;
          siblingCount++;
          if (categoryStats[category]) {
            categoryStats[category].inherited++;
            categoryStats[category].skipped--;
          }
          stats.skipped_no_source--;

          if (VERBOSE) {
            const short = colorUrlMap.get(colorKey).replace('https://cdn.msisurfaces.com/images/', 'CDN:');
            console.log(`  ↳ ${sku.vendor_sku} [${category}] ← sibling(${colorKey}): ${short}`);
          }
        }
      }
    }

    if (siblingCount > 0) {
      console.log(`\nSibling inheritance: ${siblingCount} additional SKUs matched via same-color siblings.`);
    }

    // ── Summary ──
    console.log(`\n${'='.repeat(65)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  Total active SKUs:              ${stats.total_skus}`);
    console.log(`  Already had SKU images:         ${stats.already_have_images}`);
    console.log(`  CDN probe matched:              ${stats.cdn_matched}`);
    console.log(`  Sibling inherited:              ${siblingCount}`);
    console.log(`  Parent SKU inherited:           ${stats.parent_inherited - siblingCount}`);
    console.log(`  Skipped (no source):            ${stats.skipped_no_source}`);
    console.log(`  Total media_assets to insert:   ${inserts.length}`);

    console.log(`\nPer-category breakdown:`);
    for (const [cat, cs] of Object.entries(categoryStats).sort((a, b) => b[1].total - a[1].total)) {
      const newCoverage = cs.covered + cs.cdn + cs.inherited;
      const pct = cs.total > 0 ? (100 * newCoverage / cs.total).toFixed(1) : '0.0';
      console.log(`  ${cat.padEnd(28)} ${cs.total} SKUs → ${newCoverage} covered (${pct}%) [cdn:${cs.cdn} inherit:${cs.inherited} skip:${cs.skipped}]`);
    }

    if (inserts.length === 0) {
      console.log('\nNo new SKU-level images to insert.');
      return;
    }

    // Show sample inserts
    console.log(`\nSample inserts (first 30 primary):`);
    let shown = 0;
    for (const ins of inserts) {
      if (shown >= 30) break;
      if (ins.assetType !== 'primary') continue;
      const short = ins.url.replace('https://cdn.msisurfaces.com/images/', 'CDN:').replace(/\/uploads\/products\/[^/]+\//, '/uploads/…/');
      console.log(`  ${ins.skuId.slice(0, 8)}… → ${short}`);
      shown++;
    }

    if (DRY_RUN) {
      console.log(`\nDry run — no changes made.`);
      return;
    }

    // ── Insert media_assets ──
    console.log(`\nInserting ${inserts.length} media_assets...`);
    await client.query('BEGIN');

    let inserted = 0;
    let errors = 0;
    for (const ins of inserts) {
      try {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $4, $5)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [ins.productId, ins.skuId, ins.assetType, ins.url, ins.sortOrder]);
        inserted++;
      } catch (err) {
        errors++;
        if (VERBOSE) console.log(`  Error inserting for SKU ${ins.skuId}: ${err.message}`);
      }
    }

    await client.query('COMMIT');
    console.log(`Inserted ${inserted} media_assets (${errors} errors).`);

    // ── Final coverage stats ──
    const { rows: [finalStats] } = await client.query(`
      SELECT
        COUNT(DISTINCT s.id) as total_skus,
        COUNT(DISTINCT s.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id
        )) as skus_with_images
      FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.status = 'active' AND s.status = 'active'
    `, [vendor.id]);

    console.log(`\nFinal MSI coverage: ${finalStats.skus_with_images}/${finalStats.total_skus} SKUs have per-SKU images (${(100 * finalStats.skus_with_images / finalStats.total_skus).toFixed(1)}%)`);

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\nFATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
