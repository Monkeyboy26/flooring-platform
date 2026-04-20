#!/usr/bin/env node
/**
 * Backfill Provenza product images by constructing GCS URLs directly.
 *
 * Instead of scraping the Angular SPA, we construct predictable image URLs
 * on storage.googleapis.com/provenza-web/ and verify them with HEAD requests.
 *
 * URL patterns:
 *   Hardwood: /images/products/hardwood/{slug}/detail/Provenza-{Coll}-{SKU}-{Color}.jpg
 *   LVP:      /images/products/lvp/{slug}/detail/Provenza-MaxCore-{Coll}-{NumSKU}-{Color}.jpg
 *   Laminate: /images/products/laminate/{slug}/detail/Provenza-{Coll}-{NumSKU}-{Color}.jpg
 *
 * Usage: node backend/scripts/backfill-provenza-images.cjs [--dry-run]
 */

const { Pool } = require('pg');
const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const GCS_BASE = 'https://storage.googleapis.com/provenza-web/images/products';

// Map collection names to { category, pathSlug, filePrefix }
const COLLECTION_CONFIG = {
  // ── Hardwood ──
  'Affinity':          { cat: 'hardwood', slug: 'affinity',          prefix: 'Affinity',          skuMode: 'full' },
  'African Plains':    { cat: 'hardwood', slug: 'africanplains',     prefix: 'AfricanPlains',     skuMode: 'full' },
  'Antico':            { cat: 'hardwood', slug: 'antico',            prefix: 'Antico',            skuMode: 'full' },
  'Cadeau':            { cat: 'hardwood', slug: 'cadeau',            prefix: 'Cadeau',            skuMode: 'full' },
  'Dutch Masters':     { cat: 'hardwood', slug: 'dutchmasters',      prefix: 'DutchMasters',      skuMode: 'cdm' },
  'Grand Pompeii':     { cat: 'hardwood', slug: 'grandpompeii',      prefix: 'GrandPompeii',      skuMode: 'full' },
  'Herringbone Reserve':{ cat: 'hardwood', slug: 'herringbonereserve', prefix: 'HerringboneReserve', skuMode: 'full' },
  'Herringbone Custom':{ cat: 'hardwood', slug: 'herringbonecustom', prefix: 'HerringboneCustom', skuMode: 'full' },
  'Lighthouse Cove':   { cat: 'hardwood', slug: 'lighthousecove',    prefix: 'LighthouseCove',    skuMode: 'full' },
  'Lugano':            { cat: 'hardwood', slug: 'lugano',            prefix: 'Lugano',            skuMode: 'full' },
  'Mateus':            { cat: 'hardwood', slug: 'mateus',            prefix: 'Mateus',            skuMode: 'full' },
  'Modern Rustic':     { cat: 'hardwood', slug: 'modernrustic',      prefix: 'ModernRustic',      skuMode: 'full' },
  'New York Loft':     { cat: 'hardwood', slug: 'newyorkloft',       prefix: 'NewYorkLoft',       skuMode: 'full' },
  'Old World':         { cat: 'hardwood', slug: 'oldworld',          prefix: 'OldWorld',          skuMode: 'full' },
  'Opia':              { cat: 'hardwood', slug: 'opia',              prefix: 'Opia',              skuMode: 'full' },
  'Palais Royale':     { cat: 'hardwood', slug: 'palaisroyale',      prefix: 'PalaisRoyale',      skuMode: 'full' },
  'Pompeii':           { cat: 'hardwood', slug: 'pompeii',           prefix: 'Pompeii',           skuMode: 'full' },
  'Richmond':          { cat: 'hardwood', slug: 'richmond',          prefix: 'Richmond',          skuMode: 'full' },
  'Studio Moderno':    { cat: 'hardwood', slug: 'studiomoderno',     prefix: 'StudioModerno',     skuMode: 'full' },
  'Tresor':            { cat: 'hardwood', slug: 'tresor',            prefix: 'Tresor',            skuMode: 'full' },
  'Vitali':            { cat: 'hardwood', slug: 'vitali',            prefix: 'Vitali',            skuMode: 'full' },
  'Vitali Elite':      { cat: 'hardwood', slug: 'vitalielite',       prefix: 'VitaliElite',       skuMode: 'full' },
  'Volterra':          { cat: 'hardwood', slug: 'volterra',          prefix: 'Volterra',          skuMode: 'full' },
  'Wall Chic':         { cat: 'hardwood', slug: 'wallchic',          prefix: 'WallChic',          skuMode: 'full' },

  // ── LVP (MaxCore Waterproof) ──
  'Concorde Oak':      { cat: 'lvp', slug: 'concordeoak',      prefix: 'ConcordeOak',      skuMode: 'numeric', maxcore: true },
  'First Impressions': { cat: 'lvp', slug: 'firstimpressions', prefix: 'FirstImpressions', skuMode: 'numeric', maxcore: true },
  'Moda Living':       { cat: 'lvp', slug: 'modaliving',       prefix: 'ModaLiving',       skuMode: 'numeric', maxcore: true },
  'Moda Living Elite': { cat: 'lvp', slug: 'modalivingelite',  prefix: 'ModaLivingElite',  skuMode: 'numeric', maxcore: true },
  'New Wave':          { cat: 'lvp', slug: 'newwave',          prefix: 'NewWave',          skuMode: 'numeric', maxcore: true },
  'Stonescape':        { cat: 'lvp', slug: 'stonescape',       prefix: 'Stonescape',       skuMode: 'numeric', maxcore: true },
  'Uptown Chic':       { cat: 'lvp', slug: 'uptownchic',       prefix: 'UptownChic',       skuMode: 'numeric', maxcore: true },

  // ── Laminate (MaxCore Luxury Laminate) ──
  'Modessa':           { cat: 'laminate', slug: 'modessa', prefix: 'Modessa', skuMode: 'numeric', maxcore: true },
};

// Uptown Chic is BOTH hardwood and LVP — add hardwood variant too
const UPTOWN_CHIC_HARDWOOD = { cat: 'hardwood', slug: 'uptownchic', prefix: 'UptownChic', skuMode: 'full' };

// Additional possible category paths to try
const ALT_CATEGORY_PATHS = {
  'lvp': ['waterprooflvp', 'maxcore', 'spc'],
  'laminate': ['maxcorelaminate', 'luxurylaminate'],
};

/**
 * Extract the collection name from the DB collection field
 * "Provenza - Dutch Masters" → "Dutch Masters"
 */
function extractCollectionName(dbCollection) {
  return dbCollection
    .replace(/^Provenza\s*[-–—]\s*/i, '')
    // Strip trailing size/type suffixes: "10.25\" 4mm", "(Spc-Lvp)", "Coll. 7.48\"", "Wpf"
    .replace(/\s*\d+(\.\d+)?"?\s*(4mm|6mm|mm)?\s*$/i, '')
    .replace(/\s*\(.*\)\s*$/i, '')
    .replace(/\s*Coll\.?\s*\d*.*$/i, '')
    .replace(/\s*-?Maxcore$/i, '')
    .replace(/\s*Wpf(-Lvp)?$/i, '')
    .replace(/\s*Spc\s*\d*.*$/i, '')
    .replace(/\s*Herringbone\s+\d+.*$/i, '') // "Herringbone 4""
    .trim();
}

/**
 * Clean the variant_name to get the color name
 * "Bravo 9\"X 72\"(Wpf" → "Bravo"
 * "Cover Story (Laminate)" → "Cover Story"
 * "Ancient Earth 12\"Wx24\"L" → "Ancient Earth"
 */
function extractColorName(variantName) {
  if (!variantName) return '';
  return variantName
    .replace(/\s*\d+(\.\d+)?"?\s*[xX×]\s*\d+(\.\d+)?"?\s*(\(?\w+\)?)?\s*$/i, '') // strip dimensions like 9"X 72"(Wpf
    .replace(/\s*\d+(\.\d+)?"?[Ww]\s*[xX]?\s*\d+(\.\d+)?"?[Ll]?\s*$/i, '')      // strip 12"Wx24"L
    .replace(/\s*\(Laminate\)\s*$/i, '')
    .replace(/\s*\(Wpf\s*$/i, '')
    .replace(/\s*\(Spc.*$/i, '')
    .replace(/\s+Wpf\s*$/i, '')
    .replace(/^Dutch Masters\s+/i, '')  // "Dutch Masters Bosch" → "Bosch"
    .replace(/^Provenza\s+/i, '')       // "Provenza Qtr Rnd" → leave as is
    .trim();
}

/**
 * Convert a color name to PascalCase with no spaces for URL
 * "At Ease" → "AtEase", "Bashful Beige" → "BashfulBeige"
 */
function colorToUrlPart(color) {
  return color
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Check if a URL returns 200 via HEAD request
 */
function headCheck(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Build candidate URLs for a given SKU.
 * Tries multiple patterns: with/without MaxCore, PRO prefix, -v2/-fs suffixes.
 */
function buildCandidateUrls(config, vendorSku, colorUrl) {
  const urls = [];
  const { cat, slug, prefix, maxcore, skuMode } = config;

  // Derive SKU codes: full (PRO2301), numeric (2301), CDM (CDM001)
  const fullSku = vendorSku;                           // PRO2301
  const numericSku = vendorSku.replace(/^PRO/i, '');   // 2301
  const cdmMatch = vendorSku.match(/CMD(?:10|HB)?(\d{2,3})$/i);
  const cdmSku = cdmMatch ? `CDM${cdmMatch[1].padStart(3, '0')}` : null;

  // Determine primary SKU codes to try based on collection type
  const skuCodes = [];
  if (skuMode === 'cdm' && cdmSku) {
    skuCodes.push(cdmSku);            // CDM001
  } else if (skuMode === 'numeric') {
    skuCodes.push(numericSku);        // 2301
    skuCodes.push(fullSku);           // PRO2301 (some collections need PRO prefix)
  } else {
    skuCodes.push(fullSku);           // PRO2301
    skuCodes.push(numericSku);        // 2301
  }

  // Suffixes to try
  const suffixes = ['', '-v2', '-fs'];

  for (const sku of skuCodes) {
    for (const suffix of suffixes) {
      // Pattern 1: With MaxCore prefix (LVP/laminate style)
      if (maxcore || cat === 'laminate') {
        urls.push(`${GCS_BASE}/${cat}/${slug}/detail/Provenza-MaxCore-${prefix}-${sku}-${colorUrl}${suffix}.jpg`);
      }
      // Pattern 2: Without MaxCore prefix (hardwood style)
      urls.push(`${GCS_BASE}/${cat}/${slug}/detail/Provenza-${prefix}-${sku}-${colorUrl}${suffix}.jpg`);
    }
  }

  // Try alternate category paths (e.g., 'waterprooflvp' instead of 'lvp')
  const altPaths = ALT_CATEGORY_PATHS[cat] || [];
  for (const altCat of altPaths) {
    const sku = skuCodes[0]; // Primary SKU code only for alt paths
    if (maxcore) {
      urls.push(`${GCS_BASE}/${altCat}/${slug}/detail/Provenza-MaxCore-${prefix}-${sku}-${colorUrl}.jpg`);
    }
    urls.push(`${GCS_BASE}/${altCat}/${slug}/detail/Provenza-${prefix}-${sku}-${colorUrl}.jpg`);
  }

  // Deduplicate
  return [...new Set(urls)];
}

/**
 * Upsert a media asset
 */
async function upsertImage(skuId, productId, url, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, $3, $4, $4, $5)
    ON CONFLICT (product_id, COALESCE(sku_id, '00000000-0000-0000-0000-000000000000'), asset_type, url)
    DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]).catch(async () => {
    // If unique constraint has a different shape, try with simpler approach
    const existing = await pool.query(
      `SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = $2 LIMIT 1`,
      [skuId, assetType]
    );
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order) VALUES ($1, $2, $3, $4, $4, $5)`,
        [productId, skuId, assetType, url, sortOrder]
      );
    }
  });
}

// Accessory pattern — skip these
const ACCESSORY_RE = /\b(stair\s*n|reducer|t[- ]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*(mount|square|bullnose|stair)|multi[- ]?purpose|transition|scotia|shoe\s*mold|mold|nose\s*\d|cleaner|stain\s*$|osmo|kit|qtr\s*rnd|sqr\s*nose)/i;

async function main() {
  console.log(`Provenza Image Backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(50));

  // Get all active Provenza SKUs
  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
           p.collection, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.collection LIKE 'Provenza%'
      AND p.is_active = true
    ORDER BY p.collection, s.vendor_sku
  `);

  // Get SKUs that already have primary images
  const { rows: existingImgs } = await pool.query(`
    SELECT DISTINCT sku_id FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NOT NULL
  `);
  const hasImage = new Set(existingImgs.map(r => r.sku_id));

  console.log(`Total active Provenza SKUs: ${skus.length}`);
  console.log(`Already have primary image: ${hasImage.size}`);

  let checked = 0;
  let found = 0;
  let skipped = 0;
  let notFound = 0;
  let errors = 0;
  const collectionStats = {};

  // Track products that get their first image (for product-level primary)
  const { rows: prodImgs } = await pool.query(`
    SELECT DISTINCT product_id FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NULL
  `);
  const productsWithPrimary = new Set(prodImgs.map(r => r.product_id));

  for (const sku of skus) {
    // Skip if already has image
    if (hasImage.has(sku.sku_id)) continue;

    const collName = extractCollectionName(sku.collection);
    if (!collectionStats[collName]) collectionStats[collName] = { total: 0, found: 0, skipped: 0, notFound: 0 };

    // Skip accessories and non-flooring items
    if (ACCESSORY_RE.test(sku.variant_name || '') || ACCESSORY_RE.test(sku.product_name || '')) {
      skipped++;
      collectionStats[collName].skipped++;
      continue;
    }

    // Look up collection config
    const config = COLLECTION_CONFIG[collName];
    if (!config) {
      skipped++;
      collectionStats[collName].skipped++;
      continue;
    }

    collectionStats[collName].total++;

    const colorName = extractColorName(sku.variant_name);
    if (!colorName || colorName.length < 2) {
      skipped++;
      collectionStats[collName].skipped++;
      continue;
    }

    const colorUrl = colorToUrlPart(colorName);

    // Build candidate URLs to try
    let candidates = buildCandidateUrls(config, sku.vendor_sku, colorUrl);

    // Uptown Chic special: try both hardwood and LVP
    if (collName === 'Uptown Chic') {
      candidates = [
        ...buildCandidateUrls({ ...UPTOWN_CHIC_HARDWOOD, skuMode: 'full' }, sku.vendor_sku, colorUrl),
        ...candidates,
      ];
    }

    // Deduplicate across all candidates
    candidates = [...new Set(candidates)];

    // Try each candidate URL
    let foundUrl = null;
    for (const url of candidates) {
      try {
        if (await headCheck(url)) {
          foundUrl = url;
          break;
        }
      } catch {
        errors++;
      }
    }

    checked++;

    if (foundUrl) {
      found++;
      collectionStats[collName].found++;

      // Save SKU-level primary image
      await upsertImage(sku.sku_id, sku.product_id, foundUrl, 'primary', 0);

      // Also set product-level primary if not already set
      if (!productsWithPrimary.has(sku.product_id)) {
        await upsertImage(null, sku.product_id, foundUrl, 'primary', 0);
        productsWithPrimary.add(sku.product_id);
      }

      if (found % 20 === 0) {
        console.log(`  Progress: ${checked} checked, ${found} found, ${notFound} not found`);
      }
    } else {
      notFound++;
      collectionStats[collName].notFound++;
      if (notFound <= 30) {
        console.log(`  MISS: ${sku.vendor_sku} "${colorName}" (${collName}) — tried ${candidates.length} URLs`);
      }
    }

    // Small delay to avoid hammering GCS
    if (checked % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${found} found, ${notFound} not found, ${skipped} skipped, ${errors} errors`);
  console.log('\nPer-collection:');
  for (const [coll, stats] of Object.entries(collectionStats).sort((a, b) => b[1].total - a[1].total)) {
    if (stats.total === 0 && stats.skipped === 0) continue;
    const pct = stats.total > 0 ? Math.round(stats.found / stats.total * 100) : 0;
    console.log(`  ${coll.padEnd(25)} checked=${stats.total} found=${stats.found} (${pct}%) missed=${stats.notFound} skipped=${stats.skipped}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
