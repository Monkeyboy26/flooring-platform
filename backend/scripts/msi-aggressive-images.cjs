/**
 * MSI Aggressive Image Recovery — Maximum CDN probing + listing page scraping
 *
 * Strategy:
 *   1. Scrape server-rendered listing pages for thumbnail URLs + product name mapping
 *   2. Exhaustive CDN HEAD probing with many slug variants per product
 *   3. Match listing page thumbnails to missing products via fuzzy name matching
 *   4. Sibling inheritance from same-collection products
 *
 * Usage: node backend/scripts/msi-aggressive-images.cjs [--dry-run] [--verbose]
 */

const { Pool } = require('pg');
const https = require('https');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const CDN = 'https://cdn.msisurfaces.com/images';
const BASE_URL = 'https://www.msisurfaces.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const CONCURRENCY = 25;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ─── HTTP HEAD ─────────────────────────────────────────────────────────────────

function headUrl(url, maxRedirects = 3) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { resolve(null); return; }
        resolve(headUrl(next, maxRedirects - 1));
      } else {
        resolve(res.statusCode >= 200 && res.statusCode < 300 ? url : null);
      }
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function probeAll(urls) {
  const hits = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(u => headUrl(u)));
    results.forEach(r => { if (r) hits.push(r); });
  }
  return hits;
}

// ─── Slug helpers ───────────���──────────────────────────────���───────────────────

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[®™©]+/g, '')
    .replace(/[''`"]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractColorFromName(productName, collection) {
  let name = productName || '';
  if (collection) {
    const colLower = collection.toLowerCase();
    const nameLower = name.toLowerCase();
    if (nameLower.startsWith(colLower + ' ')) name = name.slice(collection.length).trim();
    else if (nameLower.startsWith(colLower)) name = name.slice(collection.length).trim();
  }
  // Strip size, finish, shape suffixes
  name = name
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*/g, ' ')
    .replace(/\s+(matte|polished|honed|glossy|satin|brushed|tumbled|textured|rectified|lapatto|lappatpo)\s*$/i, '')
    .replace(/\s+(bullnose|pencil|chair\s*rail|quarter\s*round|mosaic|hexagon|herringbone|chevron|interlocking|3d)\s*$/i, '')
    .replace(/\s+(mesh\s+backed|peel\s+and\s+stick|veneer)\s*$/i, '')
    .replace(/\s+(classic|premium|select|gauged)\s*$/i, '')
    .replace(/^[-–—\s]+/, '').replace(/[-–—\s]+$/, '')
    .replace(/\s*[-–]\s*\d+\s*m+\b/gi, '')
    .replace(/\s*[-–]\s*\d+\s*mil\b/gi, '')
    .replace(/\s*[-–]\s*ac\b.*/i, '')
    .replace(/[-–]+\s*$/, '')
    .trim();
  return name || productName;
}

// ─── Mosaic slug builder (many variants) ───────���───────────────────────────────

function buildMosaicSlugVariants(productName) {
  const fullSlug = slugify(productName);
  const slugs = new Set([fullSlug]);

  const name = productName || '';

  // Strip size suffix
  const noSize = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/i, '').trim();
  slugs.add(slugify(noSize));

  // Strip finish/format suffixes
  const noFinish = noSize
    .replace(/\s+(matte|polished|honed|glossy|satin|brushed|tumbled|mesh\s+backed)\s*$/i, '')
    .trim();
  slugs.add(slugify(noFinish));

  // Strip shape suffixes
  const noShape = noFinish
    .replace(/\s+(interlocking|3d|hexagon|herringbone|chevron|arabesque|picket|subway|basketweave|penny\s+round|elongated\s+octagon|splitface)\s*$/i, '')
    .trim();
  slugs.add(slugify(noShape));

  // Strip mm suffix
  const noMm = noShape.replace(/\s+\d+mm\s*$/i, '').trim();
  slugs.add(slugify(noMm));

  // Strip size from middle of name
  const noMidSize = name.replace(/\s+\d+\.?\d*[xX×]\d+\.?\d*/g, '').replace(/\s+/g, ' ').trim();
  slugs.add(slugify(noMidSize));

  // Try "color-collection" and "collection-color" patterns
  const words = noShape.split(/\s+/);
  if (words.length >= 2) {
    slugs.add(slugify(words.slice(0, 2).join(' ')));
    slugs.add(slugify(words.slice(0, 3).join(' ')));
  }

  // For "Angora Herringbone" → try both "angora-herringbone" and just "angora"
  slugs.add(slugify(words[0]));

  // Add finish suffixes (CDN often includes "polished", "honed", "matte" that DB names omit)
  const finishes = ['polished', 'honed', 'matte', 'glossy'];
  const baseSlugSet = [...slugs];
  for (const slug of baseSlugSet) {
    if (!slug) continue;
    for (const finish of finishes) {
      if (!slug.endsWith(`-${finish}`)) {
        slugs.add(`${slug}-${finish}`);
      }
    }
  }

  slugs.delete('');
  return [...slugs];
}

// ─── Build EXHAUSTIVE CDN URLs for a product ───────────────────────────────────

function buildExhaustiveMosaicUrls(productName, collection, vendorSku) {
  const slugs = buildMosaicSlugVariants(productName);
  const collSlug = slugify(collection);
  const urls = new Set();

  for (const slug of slugs) {
    // mosaics directory (all sub-dirs)
    urls.add(`${CDN}/mosaics/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/detail/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/iso/${slug}-iso.jpg`);
    urls.add(`${CDN}/mosaics/edge/${slug}-edge.jpg`);
    urls.add(`${CDN}/mosaics/detail-two/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/variations/${slug}.jpg`);

    // Backsplash directory
    urls.add(`${CDN}/backsplash/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/backsplash/${slug}.jpg`);

    // Wallpanels directory
    urls.add(`${CDN}/wallpanels/${slug}.jpg`);
    urls.add(`${CDN}/wallpanels/detail/${slug}.jpg`);
    urls.add(`${CDN}/wallpanels/thumbnails/${slug}.jpg`);

    // Colornames directory
    urls.add(`${CDN}/colornames/${slug}.jpg`);
    urls.add(`${CDN}/colornames/detail/${slug}.jpg`);
    urls.add(`${CDN}/colornames/detail/${slug}-wood-slat-panels.jpg`);
    urls.add(`${CDN}/colornames/detail/${slug}-acoustic-slat-wall-panel-wood-slat-panels.jpg`);

    // Porcelain (some mosaics are porcelain)
    urls.add(`${CDN}/porcelainceramic/${slug}.jpg`);
    urls.add(`${CDN}/porcelainceramic/${slug}-porcelain.jpg`);
    urls.add(`${CDN}/porcelainceramic/${slug}-ceramic.jpg`);

    // Hardscaping (some mosaics share patterns)
    urls.add(`${CDN}/hardscaping/detail/${slug}.jpg`);

    // Common suffix patterns
    urls.add(`${CDN}/mosaics/${slug}-mosaic.jpg`);
    urls.add(`${CDN}/mosaics/${slug}-tile.jpg`);
    urls.add(`${CDN}/mosaics/detail/${slug}-tile.jpg`);
    urls.add(`${CDN}/mosaics/detail/${slug}-mosaic.jpg`);
  }

  // Wall panel specific patterns (WPNL prefix)
  if (vendorSku && vendorSku.startsWith('WPNL-')) {
    const colorFromSku = productName.replace(/^Acoustic\s+Wood\s+Slat\s+Panel\s+/i, '').trim();
    const colorSlug = slugify(colorFromSku);
    if (colorSlug) {
      urls.add(`${CDN}/colornames/detail/${colorSlug}-acoustic-slat-wall-panel-wood-slat-panels.jpg`);
      urls.add(`${CDN}/wallpanels/${colorSlug}-wood-slat-tile.jpg`);
      urls.add(`${CDN}/wallpanels/${colorSlug}-acoustic-wood-slat-panel.jpg`);
      urls.add(`${CDN}/mosaics/detail/${colorSlug}-wood-slat-tile.jpg`);
      urls.add(`${CDN}/mosaics/${colorSlug}-wood-slat-tile.jpg`);
      urls.add(`${CDN}/wallpanels/detail/${colorSlug}-acoustic-wood-slat.jpg`);
      urls.add(`${CDN}/wallpanels/thumbnails/${colorSlug}-acoustic-wood-slat.jpg`);
      // More patterns
      urls.add(`${CDN}/wallpanels/${colorSlug}.jpg`);
      urls.add(`${CDN}/wallpanels/detail/${colorSlug}.jpg`);
      urls.add(`${CDN}/colornames/detail/${colorSlug}-wood-slat-panel.jpg`);
      urls.add(`${CDN}/mosaics/detail/${colorSlug}-acoustic-wood-slat-panel.jpg`);
      // Harmony variants
      if (colorSlug.includes('harmony')) {
        const base = colorSlug.replace('harmony-', '');
        urls.add(`${CDN}/wallpanels/${base}-harmony-wood-slat-tile.jpg`);
        urls.add(`${CDN}/mosaics/detail/${base}-harmony-wood-slat-tile.jpg`);
      }
    }
  }

  // Collection-based patterns
  if (collSlug) {
    const nameNoCollection = productName.replace(new RegExp(`^${collection}\\s*`, 'i'), '').trim();
    const nameSlug = slugify(nameNoCollection);
    if (nameSlug) {
      urls.add(`${CDN}/mosaics/${nameSlug}-${collSlug}.jpg`);
      urls.add(`${CDN}/mosaics/${collSlug}-${nameSlug}.jpg`);
      urls.add(`${CDN}/mosaics/detail/${nameSlug}-${collSlug}.jpg`);
      urls.add(`${CDN}/mosaics/detail/${collSlug}-${nameSlug}.jpg`);
      urls.add(`${CDN}/mosaics/thumbnails/${nameSlug}-${collSlug}.jpg`);
      urls.add(`${CDN}/mosaics/thumbnails/${collSlug}-${nameSlug}.jpg`);
    }
  }

  // Special patterns from vendor_sku decoding
  if (vendorSku) {
    const sku = vendorSku.toUpperCase();
    // SMOT-ANGORA-BWP10MM → "angora-basketweave"
    // SMOT-GLSIL-AKANER8MM → decode glass interlocking
    // SMOT-PT-AW36 → "antique-white 3x6"
    const parts = sku.replace('SMOT-', '').replace('P-SMOT-', '').split('-');
    if (parts.length >= 1) {
      const skuSlug = slugify(parts.join(' '));
      urls.add(`${CDN}/mosaics/${skuSlug}.jpg`);
      urls.add(`${CDN}/mosaics/detail/${skuSlug}.jpg`);
    }
  }

  return [...urls];
}

function buildExhaustiveStackedStoneUrls(productName) {
  const fullSlug = slugify(productName);
  const urls = new Set();

  // Base: strip "Panel", "Corner", etc.
  const coreName = productName
    .replace(/\s*(panel|corner|corners|wht corner|mfd stacked stones corner)\s*$/i, '')
    .trim();
  const coreSlug = slugify(coreName);

  // Further strip: remove "Rockmount", "Splitface", etc.
  const baseName = coreName
    .replace(/\s*(rockmount|splitface|split\s+face|ledgestone|ledger|sq\s*rec|stacked|mosaic|flats?|veneer|fieldstone|mini\s*panel|m-?series)\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const baseSlug = slugify(baseName);

  // For LPNL products (ledger panels)
  const lpnlName = coreName.replace(/\s*3d\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  const lpnlSlug = slugify(lpnlName);

  for (const slug of [fullSlug, coreSlug, baseSlug, lpnlSlug]) {
    if (!slug) continue;
    urls.add(`${CDN}/hardscaping/detail/${slug}.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-fieldstone.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-veneer-fieldstone.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-ledger-panel.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-multi-ledger-panel.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-mini-panel.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-3d-stacked-stone.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/variations/${slug}.jpg`);
    urls.add(`${CDN}/hardscaping/variations/${slug}-stacked-stone-panels-corner2.jpg`);
    urls.add(`${CDN}/hardscaping/${slug}.jpg`);
    urls.add(`${CDN}/stackedstone/${slug}.jpg`);
    urls.add(`${CDN}/colornames/${slug}.jpg`);
    urls.add(`${CDN}/colornames/detail/${slug}.jpg`);

    // Common naming: "alaska-gray-3d-honed-stacked-stone-panels"
    urls.add(`${CDN}/hardscaping/detail/${slug}-honed-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-3d-honed-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-multi-finish-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-3d-wave-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-honed-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-3d-honed-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-multi-finish-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-3d-wave-stacked-stone-panels.jpg`);
    // Rockmount naming pattern (found on MSI listing pages)
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-rockmount-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-rockmount-stacked-stone-panels.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}-rockmount-stacked-stone.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}-rockmount-stacked-stone.jpg`);
  }

  return [...urls];
}

function buildExhaustivePorcelainUrls(productName, collection, color) {
  const fullSlug = slugify(productName);
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const urls = new Set();

  // Strip size from product name
  const noSize = productName
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*/g, ' ')
    .replace(/\s+(3d|lappatpo|bullnose)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
  const noSizeSlug = slugify(noSize);

  // Color without collection
  const cleanColor = extractColorFromName(productName, collection);
  const cleanColorSlug = slugify(cleanColor);

  for (const slug of new Set([fullSlug, noSizeSlug, cleanColorSlug, colorSlug].filter(Boolean))) {
    // Porcelain patterns
    urls.add(`${CDN}/porcelainceramic/${slug}.jpg`);
    urls.add(`${CDN}/porcelainceramic/${slug}-porcelain.jpg`);
    urls.add(`${CDN}/porcelainceramic/${slug}-ceramic.jpg`);
    urls.add(`${CDN}/porcelainceramic/detail/${slug}.jpg`);
    urls.add(`${CDN}/porcelainceramic/detail/${slug}-porcelain.jpg`);
    urls.add(`${CDN}/porcelainceramic/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/porcelainceramic/thumbnails/${slug}-porcelain.jpg`);
    urls.add(`${CDN}/porcelainceramic/iso/${slug}.jpg`);
    urls.add(`${CDN}/porcelainceramic/iso/${slug}-porcelain.jpg`);
    urls.add(`${CDN}/porcelainceramic/iso/${slug}-porcelain-iso.jpg`);
    urls.add(`${CDN}/porcelainceramic/edge/${slug}.jpg`);
    urls.add(`${CDN}/porcelainceramic/edge/${slug}-porcelain-edge.jpg`);

    // Colornames
    urls.add(`${CDN}/colornames/${slug}.jpg`);
    urls.add(`${CDN}/colornames/detail/${slug}.jpg`);
    urls.add(`${CDN}/colornames/iso/${slug}-iso.jpg`);
    urls.add(`${CDN}/colornames/edge/${slug}-edge.jpg`);

    // grey/gray swap
    const greySwap = slug.replace(/grey/g, 'gray');
    const graySwap = slug.replace(/gray/g, 'grey');
    if (greySwap !== slug) {
      urls.add(`${CDN}/porcelainceramic/${greySwap}-porcelain.jpg`);
      urls.add(`${CDN}/porcelainceramic/thumbnails/${greySwap}-porcelain.jpg`);
    }
    if (graySwap !== slug) {
      urls.add(`${CDN}/porcelainceramic/${graySwap}-porcelain.jpg`);
      urls.add(`${CDN}/porcelainceramic/thumbnails/${graySwap}-porcelain.jpg`);
    }
  }

  // Collection-color combinations
  if (collSlug && cleanColorSlug) {
    for (const suffix of ['-porcelain', '-ceramic', '']) {
      urls.add(`${CDN}/porcelainceramic/${cleanColorSlug}-${collSlug}${suffix}.jpg`);
      urls.add(`${CDN}/porcelainceramic/${collSlug}-${cleanColorSlug}${suffix}.jpg`);
      urls.add(`${CDN}/porcelainceramic/thumbnails/${cleanColorSlug}-${collSlug}${suffix}.jpg`);
      urls.add(`${CDN}/porcelainceramic/thumbnails/${collSlug}-${cleanColorSlug}${suffix}.jpg`);
      urls.add(`${CDN}/porcelainceramic/detail/${cleanColorSlug}-${collSlug}${suffix}.jpg`);
      urls.add(`${CDN}/porcelainceramic/detail/${collSlug}-${cleanColorSlug}${suffix}.jpg`);
      urls.add(`${CDN}/porcelainceramic/iso/${cleanColorSlug}-${collSlug}${suffix}-iso.jpg`);
    }
  }

  return [...urls];
}

function buildExhaustiveNaturalStoneUrls(productName, color) {
  const fullSlug = slugify(productName);
  const colorSlug = slugify(color);
  const urls = new Set();

  const coreName = productName
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*/g, ' ')
    .replace(/\s+(gauged|polished|honed|tumbled|brushed|filled|unfilled|hon\s+bev|splitface|peel\s+and\s+stick|veneer|mosaic|pencil|picket)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
  const coreSlug = slugify(coreName);

  const stoneTypes = ['marble', 'travertine', 'granite', 'limestone', 'slate', 'quartzite', 'sandstone', 'onyx'];

  for (const slug of new Set([fullSlug, coreSlug, colorSlug].filter(Boolean))) {
    // Natural stone directories
    urls.add(`${CDN}/naturalstone/${slug}.jpg`);
    urls.add(`${CDN}/naturalstone/detail/${slug}.jpg`);
    urls.add(`${CDN}/naturalstone/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/detail/${slug}.jpg`);
    urls.add(`${CDN}/mosaics/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/hardscaping/detail/${slug}.jpg`);
    urls.add(`${CDN}/hardscaping/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/colornames/${slug}.jpg`);
    urls.add(`${CDN}/colornames/detail/${slug}.jpg`);
    urls.add(`${CDN}/colornames/fullslab/${slug}.jpg`);

    // Stone type suffixes
    for (const st of stoneTypes) {
      urls.add(`${CDN}/colornames/${slug}-${st}.jpg`);
      urls.add(`${CDN}/colornames/detail/${slug}-${st}.jpg`);
      urls.add(`${CDN}/colornames/fullslab/${slug}-${st}.jpg`);
    }
  }

  return [...urls];
}

function buildExhaustiveLvpUrls(productName, collection, color) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const urls = new Set();

  if (colorSlug) {
    urls.add(`${CDN}/lvt/detail/${colorSlug}.jpg`);
    urls.add(`${CDN}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`);
    urls.add(`${CDN}/lvt/thumbnails/${colorSlug}-vinyl-flooring.jpg`);
    urls.add(`${CDN}/lvt/iso/${colorSlug}-vinyl-flooring-iso.jpg`);
    urls.add(`${CDN}/colornames/${colorSlug}.jpg`);
    urls.add(`${CDN}/colornames/thumbnails/${colorSlug}.jpg`);
  }
  if (colorSlug && collSlug) {
    for (const prefix of ['', 'xl-', 'xxl-']) {
      urls.add(`${CDN}/lvt/detail/${prefix}${colorSlug}-${collSlug}-vinyl-flooring.jpg`);
      urls.add(`${CDN}/lvt/detail/${prefix}${collSlug}-${colorSlug}-vinyl-flooring.jpg`);
      urls.add(`${CDN}/lvt/detail/${prefix}${colorSlug}-${collSlug}.jpg`);
      urls.add(`${CDN}/lvt/thumbnails/${prefix}${colorSlug}-${collSlug}-vinyl-flooring.jpg`);
      urls.add(`${CDN}/lvt/thumbnails/${prefix}${collSlug}-${colorSlug}-vinyl-flooring.jpg`);
      urls.add(`${CDN}/colornames/thumbnails/${prefix}${colorSlug}-${collSlug}.jpg`);
    }
    // Prescott/Cyrus 2.0 variants
    const baseCollSlug = collSlug.replace(/^xl-/, '').replace(/^xxl-/, '');
    if (['cyrus', 'prescott', 'andover', 'glenridge'].includes(baseCollSlug)) {
      urls.add(`${CDN}/lvt/detail/${colorSlug}-${baseCollSlug}-2-0-vinyl-flooring.jpg`);
      urls.add(`${CDN}/lvt/detail/${baseCollSlug}-2-${colorSlug}-vinyl-flooring.jpg`);
    }
  }

  return [...urls];
}

function buildExhaustiveHardwoodUrls(productName, collection, color) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);
  const urls = new Set();

  for (const slug of new Set([colorSlug, nameSlug].filter(Boolean))) {
    urls.add(`${CDN}/hardwood/detail/${slug}.jpg`);
    urls.add(`${CDN}/hardwood/detail/${slug}-hardwood-flooring.jpg`);
    urls.add(`${CDN}/hardwood/detail/${slug}-engineered-hardwood-flooring.jpg`);
    urls.add(`${CDN}/hardwood/thumbnails/${slug}.jpg`);
    urls.add(`${CDN}/hardwood/thumbnails/${slug}-hardwood-flooring.jpg`);
    urls.add(`${CDN}/lvt/detail/${slug}.jpg`);
    urls.add(`${CDN}/lvt/detail/${slug}-hardwood-flooring.jpg`);
    urls.add(`${CDN}/colornames/${slug}.jpg`);
  }
  if (collSlug && colorSlug) {
    urls.add(`${CDN}/hardwood/detail/${collSlug}-${colorSlug}-hardwood-flooring.jpg`);
    urls.add(`${CDN}/hardwood/detail/${colorSlug}-${collSlug}-hardwood-flooring.jpg`);
    urls.add(`${CDN}/hardwood/detail/${collSlug}-${colorSlug}.jpg`);
    urls.add(`${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`);
    urls.add(`${CDN}/lvt/detail/${colorSlug}-${collSlug}.jpg`);
  }

  return [...urls];
}

// ─── Build all CDN URLs based on category ─────────���────────────────────────────

function buildAllUrls(sku) {
  const cat = (sku.category || '').toLowerCase();
  const urls = new Set();

  // Primary category patterns
  if (/mosaic|backsplash/i.test(cat)) {
    buildExhaustiveMosaicUrls(sku.product_name, sku.collection, sku.vendor_sku).forEach(u => urls.add(u));
    // Many mosaic-category products are actually porcelain or natural stone
    buildExhaustivePorcelainUrls(sku.product_name, sku.collection, sku.color).forEach(u => urls.add(u));
    buildExhaustiveNaturalStoneUrls(sku.product_name, sku.color).forEach(u => urls.add(u));
  } else if (/stacked.*stone|ledger/i.test(cat)) {
    buildExhaustiveStackedStoneUrls(sku.product_name).forEach(u => urls.add(u));
  } else if (/porcelain|ceramic/i.test(cat)) {
    buildExhaustivePorcelainUrls(sku.product_name, sku.collection, sku.color).forEach(u => urls.add(u));
    buildExhaustiveMosaicUrls(sku.product_name, sku.collection, sku.vendor_sku).forEach(u => urls.add(u));
  } else if (/natural.*stone|marble|granite|travertine/i.test(cat)) {
    buildExhaustiveNaturalStoneUrls(sku.product_name, sku.color).forEach(u => urls.add(u));
    buildExhaustiveMosaicUrls(sku.product_name, sku.collection, sku.vendor_sku).forEach(u => urls.add(u));
  } else if (/lvp|vinyl|spc|wpc|rigid|waterproof/i.test(cat)) {
    buildExhaustiveLvpUrls(sku.product_name, sku.collection, sku.color).forEach(u => urls.add(u));
  } else if (/hardwood|engineered/i.test(cat)) {
    buildExhaustiveHardwoodUrls(sku.product_name, sku.collection, sku.color).forEach(u => urls.add(u));
  } else {
    // Fallback: try everything
    buildExhaustiveMosaicUrls(sku.product_name, sku.collection, sku.vendor_sku).forEach(u => urls.add(u));
    buildExhaustivePorcelainUrls(sku.product_name, sku.collection, sku.color).forEach(u => urls.add(u));
  }

  return [...urls];
}

// ─── Image classification ────────��─────────────────────────────────────────────

function getAssetType(url) {
  if (/\/thumbnails\//.test(url)) return 'alternate';
  if (/\/iso\//.test(url)) return 'alternate';
  if (/\/edge\//.test(url)) return 'alternate';
  if (/\/variations\//.test(url)) return 'alternate';
  if (/\/roomscene/.test(url)) return 'lifestyle';
  return 'primary';
}

function getImagePriority(url) {
  if (url.includes('/detail/')) return 1;
  if (url.includes('/mosaics/') && !url.includes('/thumbnails/')) return 2;
  if (url.includes('/porcelainceramic/') && !url.includes('/thumbnails/')) return 2;
  if (url.includes('/hardscaping/') && !url.includes('/thumbnails/')) return 2;
  if (url.includes('/colornames/') && !url.includes('/thumbnails/')) return 3;
  if (url.includes('/thumbnails/')) return 5;
  if (url.includes('/iso/')) return 6;
  if (url.includes('/edge/')) return 7;
  return 4;
}

// ─── DB save ──────────────────────��────────────────��───────────────────────────

async function saveImage(productId, skuId, url, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

// ─── Listing page scraper ──────────────────────────────────────────────────────

async function fetchHtml(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Extract product name → thumbnail URL mapping from listing page HTML
function extractThumbnailMap(html) {
  const map = new Map(); // slug → [urls]

  // Pattern 1: <a href="..."><img data-src="...cdn..."></a> with product label
  // MSI uses: <a href="/path/"><img data-src="...thumb..."><label class="product-title">Name</label></a>
  const productBlockRegex = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?(?:data-src|src)="([^"]*cdn\.msisurfaces\.com[^"]*)"[\s\S]*?<label[^>]*class="product-title[^"]*"[^>]*[^<]*>([^<]+)<\/label>/gi;
  let m;
  while ((m = productBlockRegex.exec(html)) !== null) {
    const href = m[1];
    const imgUrl = m[2];
    const productLabel = m[3].trim();
    const labelSlug = slugify(productLabel);
    if (labelSlug) {
      if (!map.has(labelSlug)) map.set(labelSlug, []);
      map.get(labelSlug).push(imgUrl);
    }
    // Also store by href slug
    const parts = href.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const hrefSlug = parts[parts.length - 1];
      if (!map.has(hrefSlug)) map.set(hrefSlug, []);
      map.get(hrefSlug).push(imgUrl);
    }
  }

  // Pattern 2: <a href="..."><img alt="..."></a>
  const altImgRegex = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]*cdn\.msisurfaces\.com[^"]*)"[^>]+alt="([^"]*)"[^>]*>/gi;
  while ((m = altImgRegex.exec(html)) !== null) {
    const imgUrl = m[2];
    const altText = m[3].trim();
    // Extract product name from alt (strip "Stacked Stone Thumb", "Thumb", etc.)
    const cleanAlt = altText.replace(/\s*(Stacked Stone\s*)?Thumb$/i, '').trim();
    const altSlug = slugify(cleanAlt);
    if (altSlug && altSlug.length > 3) {
      if (!map.has(altSlug)) map.set(altSlug, []);
      map.get(altSlug).push(imgUrl);
    }
  }

  // Pattern 3: standalone thumbnail URLs from known product image directories
  const cdnRegex = /https?:\/\/cdn\.msisurfaces\.com\/images\/(mosaics|porcelainceramic|hardscaping|naturalstone|colornames|backsplash|wallpanels|lvt|hardwood)\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi;
  while ((m = cdnRegex.exec(html)) !== null) {
    const url = m[0];
    const filename = url.split('/').pop().replace(/\.(jpg|jpeg|png|webp)$/i, '');
    // Build multiple slug variants from filename
    const rawSlug = filename.toLowerCase();
    // Strip common suffixes
    const cleaned = rawSlug
      .replace(/-(?:porcelain|ceramic|vinyl-flooring|hardwood-flooring|stacked-stone-panels|rockmount-stacked-stone-panels|rockmount-stacked-stone|iso|edge|detail|thumb)$/, '');
    if (!map.has('__all__')) map.set('__all__', []);
    map.get('__all__').push({ slug: cleaned, url, filename: rawSlug });
    // Also store by filename directly
    if (!map.has(rawSlug)) map.set(rawSlug, []);
    map.get(rawSlug).push(url);
    if (cleaned !== rawSlug) {
      if (!map.has(cleaned)) map.set(cleaned, []);
      map.get(cleaned).push(url);
    }
  }

  return map;
}

// ─── Listing pages to scrape ───────────��───────────────────────────────────────

const LISTING_PAGES = [
  // Porcelain - server-rendered with thumbnails (248KB, 46+ thumbs)
  'https://www.msisurfaces.com/porcelain-tile/',
  'https://www.msisurfaces.com/wood-look-tile-and-planks/',
  'https://www.msisurfaces.com/large-format-tile/',
  // Marble / Natural stone
  'https://www.msisurfaces.com/marble-tile/',
  'https://www.msisurfaces.com/travertine-tile/',
  'https://www.msisurfaces.com/granite-tile/',
  'https://www.msisurfaces.com/natural-stone-tile/',
  // Stacked stone (164KB, 48 thumbs)
  'https://www.msisurfaces.com/hardscape/rockmount-stacked-stone/',
  'https://www.msisurfaces.com/hardscape/stacked-stone/',
  // Mosaic sub-categories — CONFIRMED server-rendered with thumbnails
  'https://www.msisurfaces.com/backsplash-tile/acoustic-wood-slat/',      // 15 thumbs
  'https://www.msisurfaces.com/backsplash-tile/arabesque/',               // 10 thumbs
  'https://www.msisurfaces.com/backsplash-tile/glass-tile/',              // 48 thumbs
  'https://www.msisurfaces.com/backsplash-tile/subway-tile/',             // 48 thumbs
  'https://www.msisurfaces.com/backsplash-tile/waterjet-cut-mosaics/',    // 12 thumbs
  'https://www.msisurfaces.com/backsplash-tile/specialty-shapes-wall-tile/', // 48 thumbs
  'https://www.msisurfaces.com/backsplash-tile/splitface-wall-tile/',     // 1 thumb
  'https://www.msisurfaces.com/backsplash-tile/bevollo-glass-tile/',      // 14 thumbs
  'https://www.msisurfaces.com/backsplash-tile/brickstaks/',              // 6 thumbs
  'https://www.msisurfaces.com/backsplash-tile/encaustic-pattern/',       // 20 thumbs
  'https://www.msisurfaces.com/backsplash-tile/geometric-pattern/',       // 48 thumbs
  'https://www.msisurfaces.com/backsplash-tile/luxor/',                   // 7 thumbs
  'https://www.msisurfaces.com/backsplash-tile/metal-tile/',              // 5 thumbs
  'https://www.msisurfaces.com/backsplash-tile/palisades-handcrafted-glass/', // 4 thumbs
  'https://www.msisurfaces.com/backsplash-tile/revaso-recycled-glass/',   // 21 thumbs
  'https://www.msisurfaces.com/backsplash-tile/rio-lago-pebbles-mosaics/', // 21 thumbs
  'https://www.msisurfaces.com/backsplash-tile/stik-wall-tile/',          // 5 thumbs
  'https://www.msisurfaces.com/backsplash-tile/trim-and-accessory-pieces-chair-rails/', // 31 thumbs
  'https://www.msisurfaces.com/backsplash-tile/wood-look-wall-tile/',     // 48 thumbs
  'https://www.msisurfaces.com/backsplash-tile/3d-large-format-wall-tile/', // 3 thumbs
  'https://www.msisurfaces.com/backsplash-tile/hyde-studio/',             // 2 thumbs
  'https://www.msisurfaces.com/mosaics/decorative-blends-mosaics/',       // 34 thumbs
  'https://www.msisurfaces.com/mosaics/collections-mosaics/',
  'https://www.msisurfaces.com/wall-tile/',
];

// ─── Main ─────────���────────────────────────────���───────────────────────────────

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log('MSI Aggressive Image Recovery');
  log('═'.repeat(60));
  if (DRY_RUN) log('DRY RUN — no DB writes');

  // ── Load missing SKUs ──
  log('Loading SKUs missing images...');
  const { rows: missingSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku,
           s.variant_name, s.variant_type,
           p.name AS product_name, p.collection,
           c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
    ORDER BY c.slug, p.collection, p.name, s.vendor_sku
  `, [VENDOR_ID]);

  log(`  ${missingSkus.length} SKUs missing images`);
  if (missingSkus.length === 0) {
    log('Nothing to do!');
    await pool.end();
    return;
  }

  // Load colors
  const colorMap = new Map();
  const { rows: attrs } = await pool.query(`
    SELECT sa.sku_id, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE a.slug = 'color' AND sa.sku_id = ANY($1)
  `, [missingSkus.map(s => s.sku_id)]);
  attrs.forEach(a => colorMap.set(a.sku_id, a.value));

  for (const sku of missingSkus) {
    const rawColor = colorMap.get(sku.sku_id) || sku.product_name;
    sku.color = extractColorFromName(rawColor, sku.collection);
  }

  // Group by product
  const productGroups = new Map();
  for (const sku of missingSkus) {
    if (!productGroups.has(sku.product_id)) {
      productGroups.set(sku.product_id, {
        product_id: sku.product_id,
        product_name: sku.product_name,
        collection: sku.collection,
        category: sku.category,
        skus: [],
      });
    }
    productGroups.get(sku.product_id).skus.push(sku);
  }

  const products = [...productGroups.values()];
  log(`  ${products.length} unique products`);

  // Category breakdown
  const byCat = {};
  for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1;
  for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    log(`    ${cat}: ${count} products`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 1: Scrape listing pages to build thumbnail URL library
  // ════════════════════════════���════════════════════════════════��════════════════

  log('');
  log('Phase 1: Scraping listing pages...');
  const allThumbnails = []; // { slug, url, filename }

  for (const pageUrl of LISTING_PAGES) {
    const html = await fetchHtml(pageUrl);
    if (!html || html.length < 10000) {
      if (VERBOSE) log(`  SKIP ${pageUrl} (${html ? html.length : 0} bytes)`);
      continue;
    }

    const map = extractThumbnailMap(html);
    const allItems = map.get('__all__') || [];
    log(`  ${pageUrl.split('.com')[1]} → ${allItems.length} thumbnails`);
    allThumbnails.push(...allItems);

    await delay(300);
  }

  // Deduplicate
  const uniqueThumbs = new Map();
  for (const t of allThumbnails) {
    if (!uniqueThumbs.has(t.url)) uniqueThumbs.set(t.url, t);
  }
  log(`  Total unique thumbnails from listing pages: ${uniqueThumbs.size}`);

  // ════��═══════════════════════════════════════��═════════════════════════════════
  // Phase 2: CDN HEAD probing (exhaustive)
  // ══════════════════════��═════════════════════════════════��═════════════════════

  log('');
  log('Phase 2: Exhaustive CDN probing...');
  let cdnMatched = 0, cdnImages = 0;
  let totalProbes = 0;

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    if ((i + 1) % 50 === 0 || i === products.length - 1) {
      log(`  Progress: ${i + 1}/${products.length} (${cdnMatched} matched, ${totalProbes} probes)`);
    }

    const sku = product.skus[0];
    const candidates = buildAllUrls(sku);
    totalProbes += candidates.length;
    if (candidates.length === 0) continue;

    const hits = await probeAll(candidates);
    if (hits.length === 0) continue;

    // Sort by priority, take best
    const sorted = hits
      .map(url => ({ url, pri: getImagePriority(url) }))
      .sort((a, b) => a.pri - b.pri)
      .slice(0, 6);

    cdnMatched++;
    product._resolved = true;

    for (const sku of product.skus) {
      let sortOrder = 0;
      for (const img of sorted) {
        const assetType = sortOrder === 0 ? 'primary' : 'alternate';
        await saveImage(product.product_id, sku.sku_id, img.url, assetType, sortOrder);
        cdnImages++;
        sortOrder++;
      }
    }

    if (VERBOSE) {
      log(`    ✓ ${product.product_name} → ${sorted.length} images (${candidates.length} probed)`);
    }
  }

  log(`  CDN probing: ${cdnMatched} products matched, ${cdnImages} images saved, ${totalProbes} total probes`);

  // ═════════════��════════════════════��══════════════════════════════���════════════
  // Phase 3: Match listing page thumbnails to unresolved products
  // ═══════��══════════════════════════════════════════════════���═══════════════════

  const stillMissing = products.filter(p => !p._resolved);
  log('');
  log(`Phase 3: Matching thumbnails for ${stillMissing.length} remaining products...`);
  let thumbMatched = 0, thumbImages = 0;

  // Build slug index from thumbnails
  const thumbBySlug = new Map();
  for (const [url, t] of uniqueThumbs) {
    const key = t.slug.toLowerCase();
    if (!thumbBySlug.has(key)) thumbBySlug.set(key, []);
    thumbBySlug.get(key).push(t.url);
    // Also index by filename
    const fnKey = t.filename.toLowerCase();
    if (!thumbBySlug.has(fnKey)) thumbBySlug.set(fnKey, []);
    thumbBySlug.get(fnKey).push(t.url);
  }

  for (const product of stillMissing) {
    const slugVariants = buildMosaicSlugVariants(product.product_name);
    // Also try collection + color patterns
    if (product.collection) {
      const col = slugify(product.collection);
      const color = slugify(extractColorFromName(product.product_name, product.collection));
      if (col && color) {
        slugVariants.push(color + '-' + col, col + '-' + color);
      }
    }

    let matchedUrls = null;
    for (const slug of slugVariants) {
      if (!slug) continue;
      const urls = thumbBySlug.get(slug);
      if (urls && urls.length > 0) {
        matchedUrls = [...new Set(urls)].slice(0, 4);
        break;
      }
    }

    // Fallback: check if any thumbnail filename contains our product slug
    if (!matchedUrls) {
      const mainSlug = slugify(product.product_name);
      if (mainSlug && mainSlug.length >= 8) {
        for (const [, t] of uniqueThumbs) {
          if (t.filename.includes(mainSlug) || mainSlug.includes(t.slug)) {
            matchedUrls = [t.url];
            break;
          }
        }
      }
    }

    if (matchedUrls) {
      thumbMatched++;
      product._resolved = true;

      for (const sku of product.skus) {
        let sortOrder = 0;
        for (const url of matchedUrls) {
          // Upgrade thumbnail to detail if possible
          const detailUrl = url.replace('/thumbnails/', '/detail/');
          const assetType = sortOrder === 0 ? 'primary' : 'alternate';
          await saveImage(product.product_id, sku.sku_id, detailUrl, assetType, sortOrder);
          thumbImages++;
          sortOrder++;
        }
      }

      if (VERBOSE) {
        log(`    �� ${product.product_name} → thumbnail match (${matchedUrls.length} images)`);
      }
    }
  }

  log(`  Thumbnail matching: ${thumbMatched} products matched, ${thumbImages} images saved`);

  // ════════════════���══════════════════════════════════════════════════════���══════
  // Phase 4: Sibling inheritance (same collection or name prefix)
  // ═══════════════════════════════════════════════════════════���══════════════════

  const stillMissing2 = products.filter(p => !p._resolved);
  log('');
  log(`Phase 4: Sibling inheritance for ${stillMissing2.length} remaining products...`);
  let siblingMatched = 0, siblingImages = 0;

  for (const product of stillMissing2) {
    const baseName = (product.product_name || '')
      .replace(/^[-–—\s]+/, '')
      .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*/gi, ' ')
      .replace(/\s+(mosaic|bullnose|pencil|hexagon|herringbone|chevron|2x2|2x4|3x6|3x12|3x18|4x12|6x12|6x24|12x24|picket)\s*$/i, '')
      .replace(/\s+(interlocking|3d|peel\s+and\s+stick|mesh\s+backed|veneer)\s*$/i, '')
      .replace(/\s+(matte|polished|honed|glossy|satin)\s*$/i, '')
      .replace(/\s+/g, ' ').trim();

    if (!baseName || baseName.length < 4) continue;

    // Try progressively shorter name prefixes
    const words = baseName.split(' ');
    let siblings = null;

    for (let len = words.length; len >= 2; len--) {
      const prefix = words.slice(0, len).join(' ');
      const { rows } = await pool.query(`
        SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
        FROM products p
        JOIN skus s ON s.product_id = p.id
        JOIN media_assets ma ON ma.sku_id = s.id
        WHERE p.vendor_id = $1
          AND p.id != $2
          AND LOWER(p.name) LIKE $3
        ORDER BY ma.sort_order
        LIMIT 4
      `, [VENDOR_ID, product.product_id, prefix.toLowerCase() + '%']);

      if (rows.length > 0) {
        siblings = rows;
        if (VERBOSE) log(`    ✓ ${product.product_name} → inherited from "${prefix}..." (${rows.length} images)`);
        break;
      }
    }

    if (siblings) {
      siblingMatched++;
      product._resolved = true;

      for (const sku of product.skus) {
        let sortOrder = 0;
        for (const img of siblings) {
          const assetType = sortOrder === 0 ? 'primary' : 'alternate';
          await saveImage(product.product_id, sku.sku_id, img.url, assetType, sortOrder);
          siblingImages++;
          sortOrder++;
        }
      }
    }
  }

  log(`  Sibling inheritance: ${siblingMatched} products matched, ${siblingImages} images saved`);

  // ── Final Report ──
  log('');
  log('Coverage report...');
  const { rows: coverage } = await pool.query(`
    SELECT c.slug as category,
      COUNT(DISTINCT s.id) as total_skus,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_images
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    GROUP BY c.slug ORDER BY total_skus DESC
  `, [VENDOR_ID]);

  let totalSkus = 0, totalWithImages = 0;
  for (const row of coverage) {
    const pct = row.total_skus > 0 ? Math.round(100 * row.with_images / row.total_skus) : 0;
    const missing = row.total_skus - row.with_images;
    log(`  ${row.category}: ${row.with_images}/${row.total_skus} (${pct}%) — ${missing} missing`);
    totalSkus += parseInt(row.total_skus);
    totalWithImages += parseInt(row.with_images);
  }

  // List remaining unresolved
  const unresolved = products.filter(p => !p._resolved);
  if (unresolved.length > 0) {
    log('');
    log(`Unresolved products (${unresolved.length}):`);
    const byCategory = {};
    for (const p of unresolved) {
      const cat = p.category || 'unknown';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(p);
    }
    for (const [cat, prods] of Object.entries(byCategory).sort((a, b) => b[1].length - a[1].length)) {
      log(`  [${cat}] (${prods.length}):`);
      for (const p of prods.slice(0, 15)) {
        const skuList = p.skus.map(s => s.vendor_sku).join(', ');
        log(`    ${p.product_name} — ${skuList}`);
      }
      if (prods.length > 15) log(`    ... and ${prods.length - 15} more`);
    }
  }

  log('');
  log('═'.repeat(60));
  log(`  RESULTS`);
  log(`  CDN probed:       ${cdnMatched} products (${cdnImages} images)`);
  log(`  Thumbnail match:  ${thumbMatched} products (${thumbImages} images)`);
  log(`  Sibling inherit:  ${siblingMatched} products (${siblingImages} images)`);
  log(`  Total matched:    ${cdnMatched + thumbMatched + siblingMatched} / ${products.length} products`);
  log(`  Total SKUs:       ${totalSkus}`);
  log(`  With images:      ${totalWithImages} (${(100 * totalWithImages / totalSkus).toFixed(1)}%)`);
  log(`  Still missing:    ${totalSkus - totalWithImages}`);
  log(`  Time:             ${Math.round((Date.now() - startTime) / 1000)}s`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
