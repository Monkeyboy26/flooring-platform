#!/usr/bin/env node
/**
 * MSI Mosaic SKU-Level Image Backfill
 *
 * Problem: MSI mosaic products group multiple pattern variants (hexagon,
 * herringbone, basketweave, etc.) under one product with only product-level
 * images. Customers toggling between variant pills see the same image.
 *
 * Strategy:
 *   1. Parse vendor_sku suffix → mosaic pattern name
 *   2. Use collection name + pattern + finish to construct CDN URLs
 *   3. HEAD-probe MSI CDN for each candidate URL
 *   4. Also match existing product-level images to specific SKUs by URL analysis
 *   5. Save matches as SKU-level media_assets
 *
 * Usage:
 *   node backend/scripts/msi-mosaic-sku-images.cjs --dry-run     # Preview only
 *   node backend/scripts/msi-mosaic-sku-images.cjs               # Execute
 *   node backend/scripts/msi-mosaic-sku-images.cjs --product "Arabescato Venato"  # One product
 *   node backend/scripts/msi-mosaic-sku-images.cjs --verbose      # Extra logging
 */
const { Pool } = require('pg');
const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const prodIdx = process.argv.indexOf('--product');
const PRODUCT_FILTER = prodIdx !== -1 ? process.argv[prodIdx + 1] : null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const CDN = 'https://cdn.msisurfaces.com/images';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text) {
  return (text || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function headUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 6000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Probe batch with concurrency limit — preserves input ordering in results
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
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// SKU suffix → pattern name mapping
// ---------------------------------------------------------------------------

// Maps the vendor_sku suffix (after SMOT-{COLLECTION}-) to CDN pattern slugs.
// Each entry returns an array of candidate slug fragments to try.
const SUFFIX_PATTERNS = {
  // Hexagon variants
  '2HEXH':    ['hexagon-honed', '2-hexagon-honed', 'honed-hexagon'],
  '2HEXP':    ['hexagon-polished', '2-hexagon-polished', 'polished-hexagon-mosaic-tile'],
  '1HEX':     ['1-hexagon-honed', 'hexagon-honed'],
  '1HEXP':    ['1-hexagon-polished', 'hexagon-polished'],
  '5HEXH':    ['hexagon-honed', '5-hexagon-honed'],
  '2HEX':     ['hexagon-polished', '2-hexagon-polished', 'hexagon-matte'],
  'HEXEL10MM':['hexagon-elongated-honed-10mm', 'hexagon-honed-10mm'],
  '2HEXM':    ['2-hexagon-matte', 'hexagon-matte'],
  '1HEXM':    ['1-hexagon-matte', 'hexagon-matte'],
  '2HEXG':    ['2-hexagon-glossy', 'hexagon-glossy'],
  '1.5HEXG':  ['hexagon-glossy'],

  // Herringbone variants
  'HBP':      ['herringbone-polished'],
  'HBH':      ['herringbone-honed'],
  '1X2HBH':   ['herringbone-honed', '1x2-herringbone-honed'],
  '1X3HBP':   ['herringbone-polished', '1x3-herringbone-polished'],
  '1X3HBM':   ['herringbone-matte', '1x3-herringbone-matte'],
  'HB10MM':   ['herringbone-polished-10mm', 'herringbone-polished'],
  'CREM-HBP': ['herringbone-polished'],

  // Basketweave variants
  'BWP':      ['basketweave-polished'],
  'BWH':      ['basketweave-honed'],
  'BWP10MM':  ['basketweave-polished-10mm', 'basketweave-polished'],
  'BW2P':     ['basketweave-polished'],
  'BWM':      ['basketweave-matte'],

  // Chevron
  'CHEVH':    ['chevron-honed'],
  'CHEVRON10MM': ['chevron-polished-10mm', 'chevron-polished'],

  // Arabesque
  'ARGH':     ['arabesque-honed'],
  'AREBESQ':  ['arabesque-polished'],
  'ARABESQ':  ['arabesque-polished', 'arabesque'],
  'ARABESQUE':['arabesque-glossy', 'arabesque-polished'],

  // Picket
  'PKH':      ['picket-honed'],
  'PKP':      ['picket-polished'],
  'PK3X12H':  ['picket-honed', '3x12-picket-honed'],

  // Cube / 3D
  'CUBEH':    ['cube-honed', '3d-cube-honed'],

  // Rhombus
  'RHO10MM':  ['rhombus-polished-10mm', 'rhombus-polished'],

  // Ellipse
  'ELLP':     ['ellipse-polished'],

  // Floret
  'FLOP':     ['floret-polished'],
  'FLORP':    ['floret-polished'],

  // Geometric
  'GEOP':     ['geometric-pattern', 'geometric-polished'],
  'GEOH':     ['geometric-honed', 'geometric-pattern-honed'],
  'GEOP10MM': ['geometric-polished-10mm', 'geometric-pattern-polished'],

  // Elongated octagon
  'OCTELP':   ['elongated-octagon-polished'],
  'OCTEL10MM':['elongated-octagon-polished-10mm', 'elongated-octagon-polished'],
  '2OCT':     ['octagon-honed'],
  '2OCTG':    ['octagon-glossy'],
  '2OCTM':    ['octagon-matte'],

  // Round / Pebble
  'ROUH':     ['round-honed'],
  'ROUP':     ['round-polished'],
  'POL10MM':  ['pebble-polished-10mm', 'polished-10mm'],
  'POL8MM':   ['polished-8mm', 'pebble-polished-8mm'],
  'PEB10MM':  ['pebble-polished-10mm'],
  'HON10MM':  ['honed-10mm', 'pebble-honed-10mm'],
  'HON13MM':  ['honed-13mm'],
  '10MM':     ['honed-10mm', '10mm'],

  // Penny round
  'PENRDH':   ['penny-round-honed'],

  // Scallop
  'SCALOP10MM': ['scallop-polished-10mm', 'scallop-polished'],
  'SCAP8MM':  ['scallop-polished-8mm', 'scallop-polished'],
  'SCALOP':   ['scallop-glossy'],

  // Star
  'STARP':    ['star-polished', 'star-pattern-polished'],

  // Pinwheel
  'PINWP':    ['pinwheel-polished'],

  // Subway / Brick
  '2X6H':     ['2x6-honed', 'subway-honed'],
  '2X6P':     ['2x6-polished', 'subway-polished'],
  '2X4HB':    ['2x4-honed-beveled', '2x4-honed'],
  '2X4PB':    ['2x4-polished-beveled', '2x4-polished'],
  '1X2H':     ['1x2-honed'],
  '3X3P10MM': ['3x3-polished-10mm'],
  '2X12STH':  ['stacked-honed', '2x12-stacked-honed'],
  '1X6STH':   ['1x6-stacked-honed', 'stacked-honed'],
  '1X6STM':   ['1x6-stacked-matte', 'stacked-matte'],
  '2X6M':     ['2x6-matte', 'subway-matte'],
  '2X6':      ['2x6-matte', '2x6-glossy'],
  '4X12M':    ['4x12-matte'],
  '2X2M':     ['2x2-matte'],
  '4X4M':     ['4x4-matte'],

  // Framework
  'FRM10MM':  ['framework-polished-10mm', 'framework-polished'],

  // Pattern-specific named (rare)
  'SAZP':     ['saz-polished', 'sazerac-polished'],
  'TIBP':     ['tabi-polished'],
  'REGP':     ['regal-polished'],
  'MODP':     ['modern-polished', 'mod-polished'],
  'LINP':     ['lincoln-polished', 'linear-polished'],
  'LYNXP':    ['lynx-polished'],
  'ALAP':     ['alandalus-polished'],
  'KAYP':     ['kayseri-polished'],
  'LOLP':     ['lollipop-polished'],
  'ESTP':     ['estate-polished'],
  'DOTP':     ['dot-polished', 'penny-polished'],
  'CEMDOTP':  ['cement-dot-polished'],
  'GRIGIOP':  ['grigio-polished'],
  'NEROP':    ['nero-polished'],
  'BLAH':     ['blanch-honed', 'honed'],
  'HATHWRKP': ['hathaway-work-polished'],
  'MISTH':    ['mist-honed', 'mist-polished'],
  'QTRFOILP': ['quatrefoil-polished'],

  // Interlocking
  'HAR8MM':   ['interlocking-8mm', 'harbor-interlocking'],
  'HARPK8MM': ['picket-8mm'],
};

// ---------------------------------------------------------------------------
// Color synonyms — MSI CDN uses inconsistent color naming
// ---------------------------------------------------------------------------

function getColorSynonyms(colorSlug) {
  const synonyms = {
    'ivory':     ['ivory', 'white'],
    'white':     ['white', 'ivory', 'bianco'],
    'gray':      ['gray', 'grey', 'grigio'],
    'grey':      ['grey', 'gray', 'grigio'],
    'charcoal':  ['charcoal', 'gray', 'dark-gray'],
    'beige':     ['beige', 'cream', 'sand'],
    'brown':     ['brown', 'espresso'],
    'black':     ['black', 'nero'],
    'blue':      ['blue', 'azul'],
    'green':     ['green', 'verde'],
    'gold':      ['gold', 'golden'],
    'red':       ['red'],
    'multicolor':['multi', 'mixed'],
  };
  return synonyms[colorSlug] || [colorSlug];
}

// ---------------------------------------------------------------------------
// Build CDN URL candidates for a mosaic SKU
// ---------------------------------------------------------------------------

function buildCandidateUrls(collectionSlug, suffixPatterns, finish, colorSlug) {
  const urls = [];
  const finishSlug = finish ? slugify(finish) : null;

  // Build base slugs: without color AND with color
  const bases = [collectionSlug];
  if (colorSlug && colorSlug !== collectionSlug && !collectionSlug.includes(colorSlug)) {
    bases.push(`${collectionSlug}-${colorSlug}`);
  }

  for (const pat of suffixPatterns) {
    for (const base of bases) {
      // Primary: mosaics/{base}-{pattern}.jpg
      urls.push(`${CDN}/mosaics/${base}-${pat}.jpg`);
      // ISO view
      urls.push(`${CDN}/mosaics/iso/${base}-${pat}-iso.jpg`);
      // Variations
      urls.push(`${CDN}/mosaics/variations/${base}-${pat}.jpg`);
      // Edge
      urls.push(`${CDN}/mosaics/edge/${base}-${pat}-edge.jpg`);
    }

    // Try without finish in the pattern (if pattern already has finish)
    const patParts = pat.split('-');
    const finishes = ['honed', 'polished', 'matte', 'glossy', 'tumbled'];
    const hasFinish = patParts.some(p => finishes.includes(p));

    if (!hasFinish && finishSlug) {
      for (const base of bases) {
        urls.push(`${CDN}/mosaics/${base}-${pat}-${finishSlug}.jpg`);
        urls.push(`${CDN}/mosaics/iso/${base}-${pat}-${finishSlug}-iso.jpg`);
      }
    }

    // Also try with "-mosaic-tile" suffix (some products use this)
    urls.push(`${CDN}/mosaics/${collectionSlug}-${pat}-mosaic-tile.jpg`);

    // Try with "polished-" prefix (used for some collections like Angora)
    if (finishSlug) {
      urls.push(`${CDN}/mosaics/${collectionSlug}-${finishSlug}-${pat}-mosaic-tile.jpg`);
    }
  }

  // Also try colornames/ fallback
  for (const pat of suffixPatterns.slice(0, 2)) {
    urls.push(`${CDN}/colornames/${collectionSlug}-${pat}.jpg`);
  }

  // Deduplicate and filter bad URLs
  return [...new Set(urls)].filter(u => !u.includes('--') && !u.endsWith('-.jpg'));
}

// Try to parse a meaningful pattern from vendor_sku suffix
function parseSuffix(vendorSku) {
  // Format: SMOT-{COLLECTION}-{SUFFIX} or just SMOT-{STUFF}
  const parts = vendorSku.split('-');
  if (parts.length < 3 || parts[0] !== 'SMOT') return null;

  // The suffix is everything after SMOT-{COLLECTION}-
  // Collection code is parts[1], suffix is the rest joined
  const collectionCode = parts[1];
  const suffix = parts.slice(2).join('-').toUpperCase();

  return { collectionCode, suffix };
}

// ---------------------------------------------------------------------------
// Match existing product images to SKUs by URL analysis
// ---------------------------------------------------------------------------

const FINISH_WORDS = new Set(['honed', 'polished', 'matte', 'glossy', 'tumbled', 'brushed', 'misc', 'natural']);
const NOISE_WORDS = new Set(['mosaic', 'tile', 'pattern', '10mm', '8mm', '6mm', '4mm', 'iso', 'edge', 'variations']);

function scoreUrlForSku(url, patternNames) {
  const urlLower = url.toLowerCase();
  let bestScore = 0;
  for (const pat of patternNames) {
    const words = pat.split('-').filter(w => w.length > 2);
    const significantWords = words.filter(w => !FINISH_WORDS.has(w) && !NOISE_WORDS.has(w));
    if (significantWords.length === 0) continue; // Skip finish-only patterns

    const matchedSig = significantWords.filter(w => urlLower.includes(w));
    if (matchedSig.length === 0) continue; // Must match at least one significant word

    // Score based on significant word matches
    const s = matchedSig.length / significantWords.length;
    if (s > bestScore) bestScore = s;
  }
  return bestScore;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMSI Mosaic SKU-Level Image Backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (PRODUCT_FILTER) console.log(`Product filter: "${PRODUCT_FILTER}"`);
  console.log('='.repeat(60) + '\n');

  const client = await pool.connect();

  try {
    // 1. Get MSI vendor
    const { rows: [vendor] } = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    if (!vendor) { console.log('ERROR: MSI vendor not found'); return; }

    // 2. Get all MSI mosaic products
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.display_name, p.collection
      FROM products p
      JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND c.name = 'Mosaic Tile' AND p.is_active = true
        ${PRODUCT_FILTER ? "AND p.name ILIKE '%' || $2 || '%'" : ''}
      ORDER BY p.name
    `, PRODUCT_FILTER ? [vendor.id, PRODUCT_FILTER] : [vendor.id]);

    // 2b. Get all SKUs for these products with their attributes
    const productIds = products.map(p => p.id);
    const { rows: allSkus } = await client.query(`
      SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.status,
        (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
         WHERE sa.sku_id = s.id AND a.name = 'Finish' LIMIT 1) as finish,
        (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
         WHERE sa.sku_id = s.id AND a.name = 'Pattern' LIMIT 1) as pattern,
        (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
         WHERE sa.sku_id = s.id AND a.name = 'Size' LIMIT 1) as size
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
    for (const p of products) {
      p.skus = skusByProduct.get(p.id) || [];
    }

    console.log(`Found ${products.length} mosaic products\n`);

    // 3. Get existing product-level images
    const { rows: existingMedia } = await client.query(`
      SELECT ma.product_id, ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND c.name = 'Mosaic Tile' AND p.is_active = true
        AND ma.sku_id IS NULL
    `, [vendor.id]);

    const imagesByProduct = new Map();
    for (const m of existingMedia) {
      if (!imagesByProduct.has(m.product_id)) imagesByProduct.set(m.product_id, []);
      imagesByProduct.get(m.product_id).push(m);
    }

    // 4. Check which SKUs already have SKU-level images
    const { rows: existingSkuMedia } = await client.query(`
      SELECT DISTINCT ma.sku_id
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND c.name = 'Mosaic Tile'
    `, [vendor.id]);
    const skusWithImages = new Set(existingSkuMedia.map(r => r.sku_id));

    // 5. Process each product
    let totalProbes = 0;
    let totalMatched = 0;
    let totalReused = 0;
    let totalSkus = 0;
    let skusMissed = 0;
    const inserts = []; // { skuId, url, assetType, sortOrder }

    for (const product of products) {
      const skus = product.skus || [];
      if (skus.length === 0) continue;

      const collSlug = slugify(product.collection || product.name);
      const productImages = imagesByProduct.get(product.id) || [];
      const cdnImages = productImages.filter(m =>
        m.url.includes('cdn.msisurfaces.com') &&
        !m.url.includes('/miscellaneous/') &&
        !m.url.includes('roomvo') &&
        !m.url.includes('prop65') &&
        !m.url.includes('warning')
      );

      if (VERBOSE) {
        console.log(`\n--- ${product.name} (${skus.length} SKUs, ${cdnImages.length} product images) ---`);
      }

      for (const sku of skus) {
        totalSkus++;
        if (skusWithImages.has(sku.id)) continue;

        const parsed = parseSuffix(sku.vendor_sku);
        const suffix = parsed ? parsed.suffix : null;
        const finish = sku.finish;
        const patternAttr = sku.pattern;

        // Get pattern slugs from suffix mapping
        let patternSlugs = suffix ? (SUFFIX_PATTERNS[suffix] || null) : null;

        // If no direct suffix match, try to build from attributes
        if (!patternSlugs && patternAttr) {
          const patSlug = slugify(patternAttr);
          const finSlug = finish ? slugify(finish) : null;
          patternSlugs = finSlug
            ? [`${patSlug}-${finSlug}`, patSlug]
            : [patSlug];
        }

        // If still nothing, try to derive from the suffix itself
        if (!patternSlugs && suffix) {
          // Try known finish suffixes: H=honed, P=polished, M=matte, G=glossy
          const suffixClean = suffix.replace(/\d+MM$/i, '').replace(/\d+X\d+/gi, '');
          const mmPart = suffix.match(/(\d+MM)$/i)?.[1]?.toLowerCase() || '';
          let finSuffix = '';
          let basePat = suffixClean;

          if (suffixClean.endsWith('H')) {
            finSuffix = 'honed';
            basePat = suffixClean.slice(0, -1);
          } else if (suffixClean.endsWith('P')) {
            finSuffix = 'polished';
            basePat = suffixClean.slice(0, -1);
          } else if (suffixClean.endsWith('M')) {
            finSuffix = 'matte';
            basePat = suffixClean.slice(0, -1);
          } else if (suffixClean.endsWith('G')) {
            finSuffix = 'glossy';
            basePat = suffixClean.slice(0, -1);
          }

          if (basePat.length >= 2) {
            const baseSlug = slugify(basePat);
            patternSlugs = mmPart
              ? [`${baseSlug}-${finSuffix}-${mmPart}`, `${baseSlug}-${finSuffix}`]
              : [`${baseSlug}-${finSuffix}`];
            patternSlugs = patternSlugs.filter(s => s && !s.endsWith('-'));
          }
        }

        if (!patternSlugs || patternSlugs.length === 0) {
          if (VERBOSE) console.log(`  ? ${sku.vendor_sku} — no pattern mapping`);
          skusMissed++;
          continue;
        }

        // Strategy 1: Probe CDN for pattern-specific images
        let matched = false;
        // Derive color slugs from variant_name, trying synonyms too
        const rawColor = sku.variant_name ? slugify(sku.variant_name) : null;
        const colorSlugs = rawColor ? getColorSynonyms(rawColor) : [];
        const candidates = [];
        for (const cs of (colorSlugs.length > 0 ? colorSlugs : [null])) {
          candidates.push(...buildCandidateUrls(collSlug, patternSlugs, finish, cs));
        }
        // Deduplicate
        const uniqueCandidates = [...new Set(candidates)];
        totalProbes += uniqueCandidates.length;

        const hits = await probeBatch(uniqueCandidates, 10);
        if (hits.length > 0) {
          // Prefer non-iso/edge/variations as primary image
          const mainHits = hits.filter(u => !u.includes('/iso/') && !u.includes('/edge/') && !u.includes('/variations/'));
          const primaryUrl = mainHits.length > 0 ? mainHits[0] : hits[0];
          const otherHits = hits.filter(u => u !== primaryUrl);

          inserts.push({
            skuId: sku.id,
            productId: product.id,
            url: primaryUrl,
            assetType: 'primary',
            sortOrder: 0,
          });
          let sortIdx = 1;
          for (const hitUrl of otherHits) {
            inserts.push({
              skuId: sku.id,
              productId: product.id,
              url: hitUrl,
              assetType: 'alternate',
              sortOrder: sortIdx,
            });
            sortIdx++;
          }
          totalMatched++;
          matched = true;
          if (VERBOSE) {
            const short = hits[0].replace('https://cdn.msisurfaces.com/images/', '');
            console.log(`  ✓ ${sku.vendor_sku} ← CDN: ${short} (+${hits.length - 1} more)`);
          }
        }

        // Strategy 2: Fallback — match existing product images to this SKU
        if (!matched && cdnImages.length > 0) {
          const scored = cdnImages.map(img => ({
            url: img.url,
            score: scoreUrlForSku(img.url, patternSlugs),
          })).filter(s => s.score >= 0.5).sort((a, b) => b.score - a.score);

          if (scored.length > 0) {
            inserts.push({
              skuId: sku.id,
              productId: product.id,
              url: scored[0].url,
              assetType: 'primary',
              sortOrder: 0,
            });
            totalReused++;
            matched = true;
            if (VERBOSE) {
              const short = scored[0].url.replace('https://cdn.msisurfaces.com/images/', '');
              console.log(`  ✓ ${sku.vendor_sku} ← reused: ${short} (score=${scored[0].score.toFixed(2)})`);
            }
          }
        }

        if (!matched) {
          skusMissed++;
          if (VERBOSE) {
            console.log(`  ✗ ${sku.vendor_sku} — no match (CDN: ${uniqueCandidates.length} tried, reuse: ${cdnImages.length} scored)`);
          }
        }
      }
    }

    // 6. Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  Total mosaic SKUs:           ${totalSkus}`);
    console.log(`  Matched via existing images: ${totalReused}`);
    console.log(`  Matched via CDN probes:      ${totalMatched}`);
    console.log(`  Total media_assets to add:   ${inserts.length}`);
    console.log(`  SKUs without match:          ${skusMissed}`);
    console.log(`  Total CDN probes:            ${totalProbes}`);

    if (inserts.length === 0) {
      console.log('\nNo SKU-level images to insert.');
      return;
    }

    // Show sample inserts
    console.log(`\nSample inserts:`);
    const shown = new Set();
    for (const ins of inserts) {
      if (shown.size >= 20) break;
      if (ins.assetType !== 'primary') continue;
      const short = ins.url.replace('https://cdn.msisurfaces.com/images/', '');
      console.log(`  ${ins.skuId} → ${short}`);
      shown.add(ins.skuId);
    }

    if (DRY_RUN) {
      console.log(`\nDry run — no changes made.`);
      return;
    }

    // 7. Insert media_assets
    console.log(`\nInserting ${inserts.length} media_assets...`);
    await client.query('BEGIN');

    let inserted = 0;
    for (const ins of inserts) {
      try {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $4, $5)
          ON CONFLICT DO NOTHING
        `, [ins.productId, ins.skuId, ins.assetType, ins.url, ins.sortOrder]);
        inserted++;
      } catch (err) {
        if (VERBOSE) console.log(`  Error inserting for SKU ${ins.skuId}: ${err.message}`);
      }
    }

    await client.query('COMMIT');
    console.log(`Inserted ${inserted} media_assets.`);

    // 8. Final coverage stats
    const { rows: [stats] } = await client.query(`
      SELECT
        COUNT(DISTINCT s.id) as total_skus,
        COUNT(DISTINCT s.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id
        )) as skus_with_images
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND c.name = 'Mosaic Tile' AND p.is_active = true AND s.status = 'active'
    `, [vendor.id]);

    console.log(`\nFinal coverage: ${stats.skus_with_images}/${stats.total_skus} mosaic SKUs have images (${(100 * stats.skus_with_images / stats.total_skus).toFixed(1)}%)`);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
