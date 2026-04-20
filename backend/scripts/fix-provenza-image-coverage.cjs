#!/usr/bin/env node
/**
 * Fix Provenza Image Coverage
 *
 * Phase 1: Fix misclassified SKUs — some flooring SKUs are actually accessories
 *          (vendor_sku ends with STN, STNSQ, QTR, RDC, TM, SQN, STNI)
 * Phase 2: Backfill flooring SKU images via GCS URL construction + HEAD checks
 * Phase 3: Backfill accessory SKU images by inheriting parent flooring color's image
 * Phase 4: Print summary report
 *
 * Usage: node backend/scripts/fix-provenza-image-coverage.cjs [--dry-run]
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

// ── GCS Collection Config (31 collections) ──
const GCS_CONFIG = {
  // Hardwood
  'Affinity':            { cat: 'hardwood',  slug: 'affinity',            prefix: 'Affinity',            skuMode: 'full' },
  'African Plains':      { cat: 'hardwood',  slug: 'africanplains',       prefix: 'AfricanPlains',       skuMode: 'full' },
  'Antico':              { cat: 'hardwood',  slug: 'antico',              prefix: 'Antico',              skuMode: 'full' },
  'Cadeau':              { cat: 'hardwood',  slug: 'cadeau',              prefix: 'Cadeau',              skuMode: 'full' },
  'Dutch Masters':       { cat: 'hardwood',  slug: 'dutchmasters',        prefix: 'DutchMasters',        skuMode: 'cdm' },
  'Grand Pompeii':       { cat: 'hardwood',  slug: 'grandpompeii',        prefix: 'GrandPompeii',        skuMode: 'full' },
  'Herringbone Reserve': { cat: 'hardwood',  slug: 'herringbonereserve',  prefix: 'HerringboneReserve',  skuMode: 'full' },
  'Herringbone Custom':  { cat: 'hardwood',  slug: 'herringbonecustom',   prefix: 'HerringboneCustom',   skuMode: 'full' },
  'Lighthouse Cove':     { cat: 'hardwood',  slug: 'lighthousecove',      prefix: 'LighthouseCove',      skuMode: 'full' },
  'Lugano':              { cat: 'hardwood',  slug: 'lugano',              prefix: 'Lugano',              skuMode: 'full' },
  'Mateus':              { cat: 'hardwood',  slug: 'mateus',              prefix: 'Mateus',              skuMode: 'full' },
  'Modern Rustic':       { cat: 'hardwood',  slug: 'modernrustic',        prefix: 'ModernRustic',        skuMode: 'full' },
  'New York Loft':       { cat: 'hardwood',  slug: 'newyorkloft',         prefix: 'NewYorkLoft',         skuMode: 'full' },
  'Old World':           { cat: 'hardwood',  slug: 'oldworld',            prefix: 'OldWorld',            skuMode: 'full' },
  'Opia':                { cat: 'hardwood',  slug: 'opia',                prefix: 'Opia',                skuMode: 'full' },
  'Palais Royale':       { cat: 'hardwood',  slug: 'palaisroyale',        prefix: 'PalaisRoyale',        skuMode: 'full' },
  'Pompeii':             { cat: 'hardwood',  slug: 'pompeii',             prefix: 'Pompeii',             skuMode: 'full' },
  'Richmond':            { cat: 'hardwood',  slug: 'richmond',            prefix: 'Richmond',            skuMode: 'full' },
  'Studio Moderno':      { cat: 'hardwood',  slug: 'studiomoderno',       prefix: 'StudioModerno',       skuMode: 'full' },
  'Tresor':              { cat: 'hardwood',  slug: 'tresor',              prefix: 'Tresor',              skuMode: 'full' },
  'Vitali':              { cat: 'hardwood',  slug: 'vitali',              prefix: 'Vitali',              skuMode: 'full' },
  'Vitali Elite':        { cat: 'hardwood',  slug: 'vitalielite',         prefix: 'VitaliElite',         skuMode: 'full' },
  'Volterra':            { cat: 'hardwood',  slug: 'volterra',            prefix: 'Volterra',            skuMode: 'full' },
  'Wall Chic':           { cat: 'hardwood',  slug: 'wallchic',            prefix: 'WallChic',            skuMode: 'full' },
  // LVP (MaxCore)
  'Concorde Oak':        { cat: 'lvp',       slug: 'concordeoak',         prefix: 'ConcordeOak',         skuMode: 'numeric', maxcore: true },
  'First Impressions':   { cat: 'lvp',       slug: 'firstimpressions',    prefix: 'FirstImpressions',    skuMode: 'numeric', maxcore: true },
  'Moda Living':         { cat: 'lvp',       slug: 'modaliving',          prefix: 'ModaLiving',          skuMode: 'numeric', maxcore: true },
  'Moda Living Elite':   { cat: 'lvp',       slug: 'modalivingelite',     prefix: 'ModaLivingElite',     skuMode: 'numeric', maxcore: true },
  'New Wave':            { cat: 'lvp',       slug: 'newwave',             prefix: 'NewWave',             skuMode: 'numeric', maxcore: true },
  'Stonescape':          { cat: 'lvp',       slug: 'stonescape',          prefix: 'Stonescape',          skuMode: 'numeric', maxcore: true },
  'Uptown Chic':         { cat: 'lvp',       slug: 'uptownchic',          prefix: 'UptownChic',          skuMode: 'numeric', maxcore: true },
  // Laminate
  'Modessa':             { cat: 'laminate',  slug: 'modessa',             prefix: 'Modessa',             skuMode: 'numeric', maxcore: true },
};

// Uptown Chic exists as both hardwood and LVP
const UPTOWN_CHIC_HARDWOOD = { cat: 'hardwood', slug: 'uptownchic', prefix: 'UptownChic', skuMode: 'full' };

// Alternate category paths to try
const ALT_CATEGORY_PATHS = {
  'lvp': ['waterprooflvp', 'maxcore', 'spc'],
  'laminate': ['maxcorelaminate', 'luxurylaminate'],
};

// ── Accessory suffix patterns ──
// Order: longest first to avoid partial matches (STNSQ before STN)
const ACCESSORY_SUFFIXES = ['STNSQ', 'STNI', 'STN', 'QTR', 'RDC', 'SQN', 'TM'];
const ACCESSORY_SUFFIX_RE = new RegExp(`(${ACCESSORY_SUFFIXES.join('|')})$`, 'i');

// Accessory name patterns (for variant_name-based detection)
const ACCESSORY_NAME_RE = /\b(stair\s*n|reducer|t[- ]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*(mount|square|bullnose|stair)|multi[- ]?purpose|transition|scotia|shoe\s*mold|mold|nose\s*\d|qtr\s*rnd|sqr?\s*nose|square\s*nose)/i;

// ── Helper functions ──

/** Extract collection name from DB collection field: "Provenza - Dutch Masters" → "Dutch Masters" */
function extractCollectionName(dbCollection) {
  return (dbCollection || '')
    .replace(/^Provenza\s*[-–—]\s*/i, '')
    .replace(/\s*\d+(\.\d+)?"?\s*(4mm|6mm|mm)?\s*$/i, '')
    .replace(/\s*\(.*\)\s*$/i, '')
    .replace(/\s*Coll\.?\s*\d*.*$/i, '')
    .replace(/\s*-?Maxcore$/i, '')
    .replace(/\s*Wpf(-Lvp)?$/i, '')
    .replace(/\s*Spc\s*\d*.*$/i, '')
    .replace(/\s*Herringbone\s+\d+.*$/i, '')
    .trim();
}

/** Clean variant_name to color name: "Bravo 9\"X 72\"(Wpf" → "Bravo" */
function extractColorName(variantName) {
  if (!variantName) return '';
  return variantName
    .replace(/\s*\d+(\.\d+)?"?\s*[xX×]\s*\d+(\.\d+)?"?\s*(\(?\w+\)?)?\s*$/i, '')
    .replace(/\s*\d+(\.\d+)?"?[Ww]\s*[xX]?\s*\d+(\.\d+)?"?[Ll]?\s*$/i, '')
    .replace(/\s*\(Laminate\)\s*$/i, '')
    .replace(/\s*\(Wpf\s*$/i, '')
    .replace(/\s*\(Spc.*$/i, '')
    .replace(/\s+Wpf\s*$/i, '')
    .replace(/^Dutch Masters\s+/i, '')
    .replace(/^Provenza\s+/i, '')
    .trim();
}

/** Convert color name to PascalCase URL part: "At Ease" → "AtEase" */
function colorToUrlPart(color) {
  return color
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** HEAD check — returns true if URL responds 200 */
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

/** Build candidate GCS URLs for a SKU */
function buildCandidateUrls(config, vendorSku, colorUrl) {
  const urls = [];
  const { cat, slug, prefix, maxcore, skuMode } = config;

  const fullSku = vendorSku;
  const numericSku = vendorSku.replace(/^PRO/i, '');
  const cdmMatch = vendorSku.match(/CMD(?:10|HB)?(\d{2,3})$/i);
  const cdmSku = cdmMatch ? `CDM${cdmMatch[1].padStart(3, '0')}` : null;

  const skuCodes = [];
  if (skuMode === 'cdm' && cdmSku) {
    skuCodes.push(cdmSku);
  } else if (skuMode === 'numeric') {
    skuCodes.push(numericSku);
    skuCodes.push(fullSku);
  } else {
    skuCodes.push(fullSku);
    skuCodes.push(numericSku);
  }

  const suffixes = ['', '-v2', '-fs'];

  for (const sku of skuCodes) {
    for (const suffix of suffixes) {
      if (maxcore || cat === 'laminate') {
        urls.push(`${GCS_BASE}/${cat}/${slug}/detail/Provenza-MaxCore-${prefix}-${sku}-${colorUrl}${suffix}.jpg`);
      }
      urls.push(`${GCS_BASE}/${cat}/${slug}/detail/Provenza-${prefix}-${sku}-${colorUrl}${suffix}.jpg`);
    }
  }

  // Alternate category paths
  const altPaths = ALT_CATEGORY_PATHS[cat] || [];
  for (const altCat of altPaths) {
    const sku = skuCodes[0];
    if (maxcore) {
      urls.push(`${GCS_BASE}/${altCat}/${slug}/detail/Provenza-MaxCore-${prefix}-${sku}-${colorUrl}.jpg`);
    }
    urls.push(`${GCS_BASE}/${altCat}/${slug}/detail/Provenza-${prefix}-${sku}-${colorUrl}.jpg`);
  }

  return [...new Set(urls)];
}

/** Upsert a media asset for a SKU */
async function upsertSkuImage(skuId, productId, url) {
  if (DRY_RUN) return;
  // Use the conditional unique index: (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, 'primary', $3, $3, 0)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
  `, [productId, skuId, url]);
}

/** Upsert a product-level primary image */
async function upsertProductImage(productId, url) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, NULL, 'primary', $2, $2, 0)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO NOTHING
  `, [productId, url]);
}

/** Strip accessory suffix from vendor_sku to get the base flooring SKU */
function stripAccessorySuffix(vendorSku) {
  if (!vendorSku) return null;
  // Match longest suffix first
  for (const suffix of ACCESSORY_SUFFIXES) {
    if (vendorSku.toUpperCase().endsWith(suffix)) {
      return vendorSku.slice(0, -suffix.length);
    }
  }
  return null;
}

// ══════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════

async function main() {
  console.log(`Provenza Image Coverage Fix${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  // ── Phase 1: Fix Misclassified SKUs ──
  console.log('\n── Phase 1: Fix Misclassified SKUs ──');

  // Find flooring SKUs (variant_type IS NULL) whose vendor_sku ends with accessory suffixes
  const { rows: misclassified } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.variant_type, s.product_id,
           p.collection, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.collection LIKE 'Provenza%'
      AND p.is_active = true
      AND s.status = 'active'
      AND s.variant_type IS NULL
    ORDER BY s.vendor_sku
  `);

  let reclassified = 0;
  const reclassifiedSamples = [];
  const reclassifiedIds = new Set(); // Track in memory for dry-run accuracy

  for (const sku of misclassified) {
    const vs = (sku.vendor_sku || '').toUpperCase();
    const vn = sku.variant_name || '';

    // Check vendor_sku suffix
    const hasSuffix = ACCESSORY_SUFFIX_RE.test(vs);
    // Check variant_name for accessory patterns
    const hasAccName = ACCESSORY_NAME_RE.test(vn) || ACCESSORY_NAME_RE.test(sku.product_name);

    if (hasSuffix || hasAccName) {
      reclassified++;
      reclassifiedIds.add(sku.sku_id);
      if (reclassifiedSamples.length < 15) {
        reclassifiedSamples.push(`  ${sku.vendor_sku} "${vn}" (${extractCollectionName(sku.collection)})`);
      }
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE skus SET variant_type = 'accessory', sell_by = 'unit', updated_at = NOW() WHERE id = $1`,
          [sku.sku_id]
        );
      }
    }
  }

  console.log(`  Scanned ${misclassified.length} flooring SKUs`);
  console.log(`  Reclassified ${reclassified} as accessories`);
  if (reclassifiedSamples.length > 0) {
    console.log('  Samples:');
    for (const s of reclassifiedSamples) console.log(s);
  }

  // ── Phase 2: Backfill Flooring SKU Images ──
  console.log('\n── Phase 2: Backfill Flooring SKU Images ──');

  // Fetch all active Provenza flooring SKUs (variant_type IS NULL after Phase 1 reclassification)
  const { rows: flooringSKUs } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
           p.collection, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.collection LIKE 'Provenza%'
      AND p.is_active = true
      AND s.status = 'active'
      AND (s.variant_type IS NULL OR s.variant_type NOT IN ('accessory'))
    ORDER BY p.collection, s.vendor_sku
  `);

  // Get existing primary images
  const { rows: existingSkuImgs } = await pool.query(`
    SELECT DISTINCT sku_id FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NOT NULL
  `);
  const hasSkuImage = new Set(existingSkuImgs.map(r => r.sku_id));

  // Get products that already have a product-level primary
  const { rows: existingProdImgs } = await pool.query(`
    SELECT DISTINCT product_id FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NULL
  `);
  const hasProductImage = new Set(existingProdImgs.map(r => r.product_id));

  // Exclude SKUs reclassified in Phase 1 (needed for dry-run accuracy)
  const actualFlooring = flooringSKUs.filter(s => !reclassifiedIds.has(s.sku_id));
  const needImage = actualFlooring.filter(s => !hasSkuImage.has(s.sku_id));
  console.log(`  Total flooring SKUs: ${actualFlooring.length} (${reclassifiedIds.size} reclassified in Phase 1)`);
  console.log(`  Already have images: ${actualFlooring.length - needImage.length}`);
  console.log(`  Missing images: ${needImage.length}`);

  let p2Checked = 0, p2Found = 0, p2NotFound = 0, p2Skipped = 0;
  const p2Stats = {}; // collection → { checked, found, notFound, skipped }

  // Map to collect flooring SKU images for Phase 3 accessory matching
  // vendor_sku → { url, colorName, collectionName }
  const flooringImageMap = new Map();

  // Also build a color → image map for fallback matching
  // "collectionName|colorName" → url
  const colorImageMap = new Map();

  // First, populate maps with SKUs that already have images
  const { rows: existingFlooringImgs } = await pool.query(`
    SELECT s.vendor_sku, s.variant_name, p.collection, ma.url
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.collection LIKE 'Provenza%'
      AND p.is_active = true
      AND ma.asset_type = 'primary'
      AND (s.variant_type IS NULL OR s.variant_type NOT IN ('accessory'))
  `);
  for (const row of existingFlooringImgs) {
    flooringImageMap.set(row.vendor_sku.toUpperCase(), {
      url: row.url,
      colorName: extractColorName(row.variant_name),
      collectionName: extractCollectionName(row.collection),
    });
    const collName = extractCollectionName(row.collection);
    const color = extractColorName(row.variant_name);
    if (collName && color) {
      colorImageMap.set(`${collName.toLowerCase()}|${color.toLowerCase()}`, row.url);
    }
  }

  for (const sku of needImage) {
    const collName = extractCollectionName(sku.collection);
    if (!p2Stats[collName]) p2Stats[collName] = { checked: 0, found: 0, notFound: 0, skipped: 0 };

    const config = GCS_CONFIG[collName];
    if (!config) {
      p2Skipped++;
      p2Stats[collName].skipped++;
      continue;
    }

    const colorName = extractColorName(sku.variant_name);
    if (!colorName || colorName.length < 2) {
      p2Skipped++;
      p2Stats[collName].skipped++;
      continue;
    }

    const colorUrl = colorToUrlPart(colorName);
    p2Stats[collName].checked++;
    p2Checked++;

    // Build candidate URLs
    let candidates = buildCandidateUrls(config, sku.vendor_sku, colorUrl);
    if (collName === 'Uptown Chic') {
      candidates = [
        ...buildCandidateUrls(UPTOWN_CHIC_HARDWOOD, sku.vendor_sku, colorUrl),
        ...candidates,
      ];
      candidates = [...new Set(candidates)];
    }

    // Try each candidate
    let foundUrl = null;
    for (const url of candidates) {
      if (await headCheck(url)) {
        foundUrl = url;
        break;
      }
    }

    if (foundUrl) {
      p2Found++;
      p2Stats[collName].found++;

      await upsertSkuImage(sku.sku_id, sku.product_id, foundUrl);

      if (!hasProductImage.has(sku.product_id)) {
        await upsertProductImage(sku.product_id, foundUrl);
        hasProductImage.add(sku.product_id);
      }

      // Record for Phase 3 accessory matching
      flooringImageMap.set(sku.vendor_sku.toUpperCase(), { url: foundUrl, colorName, collectionName: collName });
      colorImageMap.set(`${collName.toLowerCase()}|${colorName.toLowerCase()}`, foundUrl);

      if (p2Found % 20 === 0) {
        console.log(`  Progress: ${p2Checked} checked, ${p2Found} found, ${p2NotFound} missed`);
      }
    } else {
      p2NotFound++;
      p2Stats[collName].notFound++;
      if (p2NotFound <= 20) {
        console.log(`  MISS: ${sku.vendor_sku} "${colorName}" (${collName}) — tried ${candidates.length} URLs`);
      }
    }

    // Throttle to avoid hammering GCS
    if (p2Checked % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n  Phase 2 Results: ${p2Found} found, ${p2NotFound} missed, ${p2Skipped} skipped`);

  // ── Phase 3: Backfill Accessory SKU Images ──
  console.log('\n── Phase 3: Backfill Accessory SKU Images ──');

  // Fetch all accessory SKUs missing images
  const { rows: dbAccessorySKUs } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
           p.collection, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.collection LIKE 'Provenza%'
      AND p.is_active = true
      AND s.status = 'active'
      AND s.variant_type = 'accessory'
      AND s.id NOT IN (SELECT sku_id FROM media_assets WHERE sku_id IS NOT NULL AND asset_type = 'primary')
    ORDER BY p.collection, s.vendor_sku
  `);

  // In dry-run, also include the SKUs reclassified in Phase 1 (not yet in DB as accessories)
  const dbAccessoryIds = new Set(dbAccessorySKUs.map(r => r.sku_id));
  const reclassifiedNotInDb = DRY_RUN
    ? misclassified.filter(s => reclassifiedIds.has(s.sku_id) && !dbAccessoryIds.has(s.sku_id) && !hasSkuImage.has(s.sku_id))
    : [];
  const accessorySKUs = [...dbAccessorySKUs, ...reclassifiedNotInDb];

  console.log(`  Accessory SKUs missing images: ${accessorySKUs.length}${reclassifiedNotInDb.length ? ` (includes ${reclassifiedNotInDb.length} from Phase 1)` : ''}`);

  let p3Matched = 0, p3Unmatched = 0;
  const p3Stats = {}; // collection → { matched, unmatched }

  for (const acc of accessorySKUs) {
    const collName = extractCollectionName(acc.collection);
    if (!p3Stats[collName]) p3Stats[collName] = { matched: 0, unmatched: 0 };

    let imageUrl = null;

    // Strategy 1: Strip accessory suffix from vendor_sku to find base flooring SKU
    const baseSku = stripAccessorySuffix(acc.vendor_sku);
    if (baseSku) {
      const entry = flooringImageMap.get(baseSku.toUpperCase());
      if (entry) {
        imageUrl = entry.url;
      }
    }

    // Strategy 2: Match by variant_name (color name) within the same collection
    if (!imageUrl && acc.variant_name && collName) {
      const color = extractColorName(acc.variant_name);
      if (color && color.length >= 2) {
        const key = `${collName.toLowerCase()}|${color.toLowerCase()}`;
        imageUrl = colorImageMap.get(key);
      }
    }

    // Strategy 3: Fuzzy color match — try without collection prefix in variant_name
    if (!imageUrl && acc.variant_name && collName) {
      const rawColor = (acc.variant_name || '').toLowerCase().trim();
      // Try matching any flooring image in this collection
      for (const [key, url] of colorImageMap) {
        if (key.startsWith(collName.toLowerCase() + '|')) {
          const mapColor = key.split('|')[1];
          if (rawColor.includes(mapColor) || mapColor.includes(rawColor)) {
            imageUrl = url;
            break;
          }
        }
      }
    }

    if (imageUrl) {
      p3Matched++;
      p3Stats[collName].matched++;
      await upsertSkuImage(acc.sku_id, acc.product_id, imageUrl);

      if (!hasProductImage.has(acc.product_id)) {
        await upsertProductImage(acc.product_id, imageUrl);
        hasProductImage.add(acc.product_id);
      }
    } else {
      p3Unmatched++;
      p3Stats[collName].unmatched++;
      if (p3Unmatched <= 15) {
        console.log(`  MISS: ${acc.vendor_sku} "${acc.variant_name}" (${collName}) — no parent image found`);
      }
    }
  }

  console.log(`\n  Phase 3 Results: ${p3Matched} matched, ${p3Unmatched} unmatched`);

  // ── Phase 4: Summary Report ──
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Phase 1: ${reclassified} SKUs reclassified as accessories`);
  console.log(`  Phase 2: ${p2Found} flooring images found, ${p2NotFound} missed, ${p2Skipped} skipped`);
  console.log(`  Phase 3: ${p3Matched} accessory images inherited, ${p3Unmatched} unmatched`);
  console.log(`  Total new images: ${p2Found + p3Matched}`);

  // Per-collection breakdown
  const allCollections = new Set([...Object.keys(p2Stats), ...Object.keys(p3Stats)]);
  if (allCollections.size > 0) {
    console.log('\nPer-collection breakdown:');
    console.log(`  ${'Collection'.padEnd(25)} ${'Flooring'.padEnd(25)} ${'Accessories'.padEnd(25)}`);
    console.log(`  ${'-'.repeat(25)} ${'-'.repeat(25)} ${'-'.repeat(25)}`);

    for (const coll of [...allCollections].sort()) {
      const f = p2Stats[coll] || { checked: 0, found: 0, notFound: 0, skipped: 0 };
      const a = p3Stats[coll] || { matched: 0, unmatched: 0 };
      const fPct = f.checked > 0 ? Math.round(f.found / f.checked * 100) : '-';
      const aPct = (a.matched + a.unmatched) > 0 ? Math.round(a.matched / (a.matched + a.unmatched) * 100) : '-';
      const fStr = f.checked > 0 ? `${f.found}/${f.checked} (${fPct}%)` : `skip=${f.skipped}`;
      const aStr = (a.matched + a.unmatched) > 0 ? `${a.matched}/${a.matched + a.unmatched} (${aPct}%)` : 'n/a';
      console.log(`  ${coll.padEnd(25)} ${fStr.padEnd(25)} ${aStr.padEnd(25)}`);
    }
  }

  // Final coverage check
  if (!DRY_RUN) {
    const { rows: [coverage] } = await pool.query(`
      SELECT
        COUNT(s.id) AS total_skus,
        COUNT(ma.sku_id) AS skus_with_images,
        COUNT(CASE WHEN s.variant_type = 'accessory' THEN 1 END) AS accessory_skus,
        COUNT(CASE WHEN s.variant_type = 'accessory' AND ma.sku_id IS NOT NULL THEN 1 END) AS accessory_with_images,
        COUNT(CASE WHEN s.variant_type IS NULL THEN 1 END) AS flooring_skus,
        COUNT(CASE WHEN s.variant_type IS NULL AND ma.sku_id IS NOT NULL THEN 1 END) AS flooring_with_images
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
      WHERE p.collection LIKE 'Provenza%'
        AND p.is_active = true
        AND s.status = 'active'
    `);

    console.log('\nFinal Coverage:');
    console.log(`  Total SKUs:     ${coverage.total_skus} (${coverage.skus_with_images} with images, ${Math.round(coverage.skus_with_images / coverage.total_skus * 100)}%)`);
    console.log(`  Flooring SKUs:  ${coverage.flooring_skus} (${coverage.flooring_with_images} with images, ${coverage.flooring_skus > 0 ? Math.round(coverage.flooring_with_images / coverage.flooring_skus * 100) : 0}%)`);
    console.log(`  Accessory SKUs: ${coverage.accessory_skus} (${coverage.accessory_with_images} with images, ${coverage.accessory_skus > 0 ? Math.round(coverage.accessory_with_images / coverage.accessory_skus * 100) : 0}%)`);
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
