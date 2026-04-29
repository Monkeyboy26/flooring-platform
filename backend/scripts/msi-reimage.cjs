/**
 * MSI Re-Image — Complete CDN-based image assignment
 *
 * Discovered patterns from exploring msisurfaces.com (April 2026):
 *
 * Product-level (per color):
 *   colornames/{color}-{collection}.jpg                    — main product shot (3000x3000)
 *   colornames/iso/{color}-{collection}-iso.jpg            — ISO/angled view
 *   colornames/edge/{color}-{collection}-edge.jpg          — edge detail
 *   colornames/thumbnails/{color}-{collection}.jpg         — thumbnail
 *
 * Per-SKU (vendor SKU embedded in URL):
 *   colornames/skus/thumbnails/{color}-{collection}-suk-{vendorSku}.jpg
 *
 * Category-specific:
 *   porcelainceramic/{color}-{collection}-porcelain.jpg
 *   lvt/thumbnails/{color}-{collection}-vinyl-flooring.jpg
 *   mosaics/{name-slug}.jpg
 *   hardscaping/{name-slug}.jpg
 *   stackedstone/{name-slug}.jpg
 *   naturalstone/{name-slug}.jpg
 *
 * Room scenes:
 *   roomscenes/medium/{collection}-{color}-{room}-{id}.jpg
 *
 * Strategy:
 *   1. Delete ALL existing MSI media_assets (they're wrong)
 *   2. For each SKU, build candidate URLs from product name + collection
 *   3. HEAD-probe the CDN to confirm existence
 *   4. Save per-SKU images (sku_id populated)
 *   5. Inherit from siblings for any remaining gaps
 */

const { Pool } = require('pg');
const https = require('https');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const CDN = 'https://cdn.msisurfaces.com/images';
const CONCURRENCY = 25;
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_DELETE = process.argv.includes('--skip-delete');
const VERBOSE = process.argv.includes('--verbose');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─── HTTP HEAD ────────────────────────────────────────────────────────────────

function headUrl(url, maxRedirects = 3) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = new URL(res.headers.location, url).href;
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

// Probe all URLs concurrently, return array of hits
async function probeAll(urls) {
  const hits = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(u => headUrl(u)));
    results.forEach(r => { if (r) hits.push(r); });
  }
  return hits;
}

// ─── Slugify ──────────────────────────────────────────────────────────────────

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[®™©]+/g, '')
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Extract just the color name from product name, stripping collection prefix and size suffix
function extractColorName(productName, collection) {
  let name = productName || '';
  // Remove collection prefix
  if (collection) {
    const colLower = collection.toLowerCase();
    const nameLower = name.toLowerCase();
    if (nameLower.startsWith(colLower + ' ')) {
      name = name.slice(collection.length).trim();
    } else if (nameLower.startsWith(colLower)) {
      name = name.slice(collection.length).trim();
    }
  }
  // Strip size patterns: "12x24", "18x18", "3x18", etc.
  name = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/g, '').trim();
  // Strip finish/format suffixes
  name = name.replace(/\s+(matte|polished|honed|glossy|satin|brushed|tumbled|textured|rectified)\s*$/i, '').trim();
  // Strip bullnose/trim suffixes
  name = name.replace(/\s+(bullnose|pencil|chair\s*rail|quarter\s*round|mosaic|hexagon|herringbone|chevron)\s*$/i, '').trim();
  // Strip "Classic", "Gauged" etc
  name = name.replace(/\s+(classic|premium|select|gauged)\s*$/i, '').trim();
  // Strip trailing size again
  name = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/g, '').trim();
  // Strip leading "2.0 " or "XL " or "XXL " version prefix
  name = name.replace(/^\d+\.?\d*\s+/i, '').trim();
  name = name.replace(/^(XL|XXL)\s+/i, '').trim();
  return name || productName;
}

// ─── URL Builders ─────────────────────────────────────────────────────────────

function buildColorNameUrls(color, collection, productName) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);
  const urls = [];

  if (colorSlug && collSlug) {
    urls.push(
      // Primary product shot (3000x3000)
      `${CDN}/colornames/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/colornames/${collSlug}-${colorSlug}.jpg`,
      // ISO view
      `${CDN}/colornames/iso/${colorSlug}-${collSlug}-iso.jpg`,
      `${CDN}/colornames/iso/${collSlug}-${colorSlug}-iso.jpg`,
      // Edge view
      `${CDN}/colornames/edge/${colorSlug}-${collSlug}-edge.jpg`,
      `${CDN}/colornames/edge/${collSlug}-${colorSlug}-edge.jpg`,
      // Thumbnails
      `${CDN}/colornames/thumbnails/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/colornames/thumbnails/${collSlug}-${colorSlug}.jpg`,
    );
  }

  // Color-only (no collection) — works for Cyrus colors like wolfeboro, jenta, boswell
  if (colorSlug) {
    urls.push(
      `${CDN}/colornames/${colorSlug}.jpg`,
      `${CDN}/colornames/thumbnails/${colorSlug}.jpg`,
    );
  }

  // Also try full product name slug (works for products without a collection)
  if (nameSlug && nameSlug !== colorSlug) {
    urls.push(
      `${CDN}/colornames/${nameSlug}.jpg`,
      `${CDN}/colornames/thumbnails/${nameSlug}.jpg`,
    );
  }

  return urls;
}

function buildPerSkuUrls(color, collection, vendorSku) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const skuSlug = vendorSku.toLowerCase();
  if (!colorSlug || !collSlug) return [];

  return [
    `${CDN}/colornames/skus/thumbnails/${colorSlug}-${collSlug}-suk-${skuSlug}.jpg`,
    `${CDN}/colornames/skus/thumbnails/${collSlug}-${colorSlug}-suk-${skuSlug}.jpg`,
  ];
}

function buildLvpUrls(color, collection, vendorSku) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const urls = [];

  // Pattern 0: color-only, no suffix (works for Smithcliffs: brockton.jpg, hillsdale.jpg)
  if (colorSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}.jpg`,
      `${CDN}/lvt/thumbnails/${colorSlug}.jpg`,
    );
  }

  // Pattern 1: color-only with suffix (newer products like Andover Bellamy Brooks)
  if (colorSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/iso/${colorSlug}-vinyl-flooring-iso.jpg`,
      `${CDN}/lvt/edge/${colorSlug}-vinyl-flooring-edge.jpg`,
      `${CDN}/lvt/thumbnails/${colorSlug}-vinyl-flooring.jpg`,
    );
  }

  // Pattern 2: collection-color combos
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}-${collSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/thumbnails/${colorSlug}-${collSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/thumbnails/${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/lvt/${colorSlug}-${collSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/xl-${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/xxl-${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
      // Andover-style collection prefix in thumbnails
      `${CDN}/lvt/thumbnails/${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
    );
    // Pattern 2b: collection with "2.0" suffix (Cyrus 2.0: akadia-cyrus-2.0-vinyl-flooring.jpg)
    const baseCollSlug = collSlug.replace(/^xl-/, '').replace(/^xxl-/, '');
    if (baseCollSlug === 'cyrus' || baseCollSlug === 'prescott') {
      urls.push(
        `${CDN}/lvt/detail/${colorSlug}-${baseCollSlug}-2.0-vinyl-flooring.jpg`,
        `${CDN}/lvt/detail/${baseCollSlug}-2-${colorSlug}-vinyl-flooring.jpg`,
        `${CDN}/lvt/thumbnails/${colorSlug}-${baseCollSlug}-2.0-vinyl-flooring.jpg`,
        `${CDN}/lvt/thumbnails/${baseCollSlug}-2-${colorSlug}-vinyl-flooring.jpg`,
      );
    }
    if (collSlug.startsWith('xl-')) {
      // XL variants: xl-cyrus → try xl-cyrus, cyrus-xl, etc.
      urls.push(
        `${CDN}/lvt/detail/${colorSlug}-${collSlug}-vinyl-flooring.jpg`,
        `${CDN}/lvt/detail/${colorSlug}-${baseCollSlug}-xl-vinyl-flooring.jpg`,
        `${CDN}/lvt/thumbnails/${colorSlug}-${collSlug}-vinyl-flooring.jpg`,
      );
    }
  }

  // Pattern 3: per-SKU front view (e.g., bellamy-brooks-7x48-5mm-20mil.jpg)
  if (vendorSku) {
    // Extract size info from vendor_sku (e.g., VTRBELBRO7X48-5MM-20MIL → 7x48-5mm-20mil)
    const sizeMatch = vendorSku.match(/(\d+\.?\d*X\d+)-(\d+\.?\d*MM)-(\d+MIL)/i);
    if (sizeMatch && colorSlug) {
      const sizeStr = `${sizeMatch[1]}-${sizeMatch[2]}-${sizeMatch[3]}`.toLowerCase();
      urls.push(`${CDN}/lvt/front/thumbnails/${colorSlug}-${sizeStr}.jpg`);
    }
  }

  return urls;
}

function buildPorcelainUrls(color, collection, productName, variantName) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);
  const urls = [];

  // Grey/gray mapping — MSI uses American "gray" in CDN URLs
  const colorAlt = colorSlug.replace(/grey/g, 'gray');
  const nameAlt = nameSlug.replace(/grey/g, 'gray');
  const colorSlugs = [colorSlug];
  if (colorAlt !== colorSlug) colorSlugs.push(colorAlt);
  const nameSlugs = [nameSlug];
  if (nameAlt !== nameSlug) nameSlugs.push(nameAlt);

  // Pattern 1: {color}-{collection}-porcelain.jpg (Durban Grey → gray-durban-porcelain.jpg)
  if (colorSlug && collSlug) {
    for (const cs of colorSlugs) {
      urls.push(
        `${CDN}/porcelainceramic/${cs}-${collSlug}-porcelain.jpg`,
        `${CDN}/porcelainceramic/${collSlug}-${cs}-porcelain.jpg`,
        `${CDN}/porcelainceramic/thumbnails/${cs}-${collSlug}-porcelain.jpg`,
        `${CDN}/porcelainceramic/thumbnails/${collSlug}-${cs}-porcelain.jpg`,
        `${CDN}/porcelainceramic/${cs}-${collSlug}.jpg`,
        `${CDN}/porcelainceramic/${cs}-${collSlug}-ceramic.jpg`,
      );
    }
  }

  // Pattern 2: {product-name}-{size}.jpg (Brighton Gold → brighton-gold-12x24.jpg)
  // Extract size from variant_name (e.g., "24X24 Matte" → "24x24")
  const sizeMatch = (variantName || '').match(/(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);
  if (sizeMatch && nameSlug) {
    const size = `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase();
    for (const ns of nameSlugs) {
      urls.push(
        `${CDN}/porcelainceramic/${ns}-${size}.jpg`,
        `${CDN}/porcelainceramic/thumbnails/${ns}-${size}.jpg`,
        `${CDN}/porcelainceramic/iso/${ns}-${size}-iso.jpg`,
      );
    }
  }

  // Pattern 3: product name only (no size, no suffix)
  if (nameSlug) {
    for (const ns of nameSlugs) {
      urls.push(
        `${CDN}/porcelainceramic/${ns}.jpg`,
        `${CDN}/porcelainceramic/thumbnails/${ns}.jpg`,
      );
    }
  }

  // Pattern 4: colornames for porcelain
  if (nameSlug) {
    for (const ns of nameSlugs) {
      urls.push(
        `${CDN}/colornames/${ns}.jpg`,
        `${CDN}/colornames/thumbnails/${ns}.jpg`,
      );
    }
  }

  return urls;
}

function buildMosaicUrls(color, collection, productName, variantName) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);

  // Build name without trailing size for shorter slug
  const shortName = (productName || '')
    .replace(/\s+\d+x\d+.*$/i, '')
    .replace(/\s+(mesh\s*backed|polished|glossy|matte|honed|tumbled)\s*$/i, '')
    .trim();
  const shortSlug = slugify(shortName);

  // Extract size from variant_name for {name}-{size}.jpg pattern (e.g., kenzzi-tamensa-8x8.jpg)
  const sizeMatch = (variantName || '').match(/(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);
  const sizeStr = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase() : null;

  const urls = [
    // Full product name slug (this is the primary CDN pattern for mosaics)
    `${CDN}/mosaics/${nameSlug}.jpg`,
    `${CDN}/mosaics/thumbnails/${nameSlug}.jpg`,
    // Short name (without trailing suffixes)
    `${CDN}/mosaics/${shortSlug}.jpg`,
    `${CDN}/mosaics/thumbnails/${shortSlug}.jpg`,
  ];

  // Product name + size from variant (e.g., kenzzi-tamensa-8x8.jpg)
  if (sizeStr && nameSlug) {
    urls.push(
      `${CDN}/mosaics/${nameSlug}-${sizeStr}.jpg`,
      `${CDN}/mosaics/thumbnails/${nameSlug}-${sizeStr}.jpg`,
    );
  }
  if (sizeStr && shortSlug && shortSlug !== nameSlug) {
    urls.push(
      `${CDN}/mosaics/${shortSlug}-${sizeStr}.jpg`,
      `${CDN}/mosaics/thumbnails/${shortSlug}-${sizeStr}.jpg`,
    );
  }

  urls.push(
    // ISO and edge views
    `${CDN}/mosaics/iso/${nameSlug}-iso.jpg`,
    `${CDN}/mosaics/edge/${nameSlug}-edge.jpg`,
    // Backsplash directory
    `${CDN}/backsplash/${nameSlug}.jpg`,
    `${CDN}/backsplash/thumbnails/${nameSlug}.jpg`,
    `${CDN}/backsplash/${shortSlug}.jpg`,
    // Wall panels
    `${CDN}/wallpanels/${nameSlug}.jpg`,
    `${CDN}/wallpanels/thumbnails/${nameSlug}.jpg`,
  );
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/mosaics/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/mosaics/${collSlug}-${colorSlug}.jpg`,
      `${CDN}/mosaics/thumbnails/${colorSlug}-${collSlug}.jpg`,
    );
  }
  // Color-only
  if (colorSlug) {
    urls.push(`${CDN}/mosaics/${colorSlug}.jpg`);
    urls.push(`${CDN}/mosaics/thumbnails/${colorSlug}.jpg`);
  }
  return urls;
}

function buildStackedStoneUrls(color, collection, productName) {
  const nameSlug = slugify(productName);
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);

  // Strip decorative suffixes to get core name for CDN patterns
  const coreName = (productName || '')
    .replace(/\s*(panel|corner|corners|wht corner)\s*$/i, '')
    .trim();
  const coreSlug = slugify(coreName);

  // Strip more to get base stone name (no format words)
  const baseName = (coreName)
    .replace(/\s*(rockmount|splitface|ledgestone|ledger|sq\s*rec|stacked|mosaic|flats?|veneer|fieldstone)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const baseSlug = slugify(baseName);

  const urls = [
    // Primary pattern: hardscaping/detail/{name}-stacked-stone-panels.jpg
    `${CDN}/hardscaping/detail/${coreSlug}-stacked-stone-panels.jpg`,
    `${CDN}/hardscaping/thumbnails/${coreSlug}-stacked-stone-panels.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}-stacked-stone-panels.jpg`,
    `${CDN}/hardscaping/thumbnails/${baseSlug}-stacked-stone-panels.jpg`,
    // Fieldstone/veneer pattern
    `${CDN}/hardscaping/detail/${coreSlug}-fieldstone.jpg`,
    `${CDN}/hardscaping/thumbnails/${coreSlug}-fieldstone.jpg`,
    `${CDN}/hardscaping/detail/${coreSlug}.jpg`,
    `${CDN}/hardscaping/thumbnails/${coreSlug}.jpg`,
    // With "veneer" prefix
    `${CDN}/hardscaping/detail/${baseSlug}-veneer-fieldstone.jpg`,
    // Edge/variations
    `${CDN}/hardscaping/edge/${coreSlug}-stacked-stone-panels-edge.jpg`,
    `${CDN}/hardscaping/variations/${coreSlug}-stacked-stone-panels-corner2.jpg`,
    // Legacy patterns
    `${CDN}/hardscaping/${nameSlug}.jpg`,
    `${CDN}/hardscaping/thumbnails/${nameSlug}.jpg`,
    `${CDN}/stackedstone/${nameSlug}.jpg`,
  ];
  return urls;
}

function buildNaturalStoneUrls(color, collection, productName) {
  const nameSlug = slugify(productName);
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);

  // Strip trailing size/format for core name
  const coreName = (productName || '')
    .replace(/\s+\d+x\d+.*$/i, '')
    .replace(/\s+(gauged|polished|honed|tumbled|brushed|filled|unfilled)\s*$/i, '')
    .trim();
  const coreSlug = slugify(coreName);

  const urls = [];
  const stoneTypes = ['marble', 'travertine', 'granite', 'limestone', 'slate', 'quartzite', 'sandstone', 'onyx'];

  // PRIMARY: colornames/{name}-{stone-type}.jpg — the confirmed working pattern
  for (const type of stoneTypes) {
    urls.push(`${CDN}/colornames/${colorSlug}-${type}.jpg`);
    urls.push(`${CDN}/colornames/thumbnails/${colorSlug}-${type}.jpg`);
    if (coreSlug !== colorSlug) {
      urls.push(`${CDN}/colornames/${coreSlug}-${type}.jpg`);
    }
  }

  // MSI sometimes puts natural stone tiles under mosaics/
  urls.push(
    `${CDN}/mosaics/${nameSlug}.jpg`,
    `${CDN}/mosaics/thumbnails/${nameSlug}.jpg`,
    `${CDN}/mosaics/${coreSlug}.jpg`,
    `${CDN}/mosaics/thumbnails/${coreSlug}.jpg`,
    `${CDN}/mosaics/iso/${nameSlug}-iso.jpg`,
    `${CDN}/mosaics/edge/${nameSlug}-edge.jpg`,
  );

  // Naturalstone and hardscaping directories
  urls.push(
    `${CDN}/naturalstone/${nameSlug}.jpg`,
    `${CDN}/naturalstone/thumbnails/${nameSlug}.jpg`,
    `${CDN}/naturalstone/${coreSlug}.jpg`,
    `${CDN}/hardscaping/detail/${nameSlug}.jpg`,
    `${CDN}/hardscaping/detail/${coreSlug}.jpg`,
  );

  // Try stone type subdirectories
  for (const type of stoneTypes) {
    urls.push(`${CDN}/${type}/${nameSlug}.jpg`);
    urls.push(`${CDN}/${type}/${coreSlug}.jpg`);
  }

  return urls;
}

function buildHardwoodUrls(color, collection) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const urls = [];

  // Primary pattern: lvt/detail/{collection}-{color}.jpg (confirmed working for Kelmore, Ladson, Mccarran)
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/lvt/thumbnails/${collSlug}-${colorSlug}.jpg`,
    );
  }
  // Color-only pattern
  if (colorSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}-hardwood-flooring.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-engineered-hardwood-flooring.jpg`,
    );
  }
  // Legacy hardwood directory patterns
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/hardwood/detail/${collSlug}-${colorSlug}-hardwood-flooring.jpg`,
      `${CDN}/hardwood/detail/${colorSlug}-${collSlug}-hardwood-flooring.jpg`,
      `${CDN}/hardwood/detail/${collSlug}-${colorSlug}.jpg`,
      `${CDN}/hardwood/thumbnails/${collSlug}-${colorSlug}.jpg`,
    );
  }
  return urls;
}

// ─── Build all candidate URLs for a SKU ──────────────────────────────────────

function buildAllUrls(sku) {
  const { category, collection, product_name, color, vendor_sku, variant_name } = sku;
  const cat = (category || '').toLowerCase();
  const urls = [];

  // Tier 1: colornames (works for all categories, highest quality)
  urls.push(...buildColorNameUrls(color, collection, product_name));

  // Tier 1.5: per-SKU images (vendor SKU in URL)
  urls.push(...buildPerSkuUrls(color, collection, vendor_sku));

  // Tier 2: category-specific paths
  if (/lvp|vinyl|spc|wpc|rigid|waterproof.*wood/i.test(cat)) {
    urls.push(...buildLvpUrls(color, collection, vendor_sku));
  } else if (/porcelain|ceramic/i.test(cat)) {
    urls.push(...buildPorcelainUrls(color, collection, product_name, variant_name));
  } else if (/mosaic|backsplash/i.test(cat)) {
    urls.push(...buildMosaicUrls(color, collection, product_name, variant_name));
  } else if (/stacked.*stone|ledger/i.test(cat)) {
    urls.push(...buildStackedStoneUrls(color, collection, product_name));
  } else if (/natural.*stone|marble|granite|travertine/i.test(cat)) {
    urls.push(...buildNaturalStoneUrls(color, collection, product_name));
  } else if (/hardwood|engineered/i.test(cat)) {
    // MSI puts hardwood images under lvt/detail/{collection}-{color}.jpg
    urls.push(...buildHardwoodUrls(color, collection));
    urls.push(...buildLvpUrls(color, collection, vendor_sku));
  } else {
    // Unknown category — try everything
    urls.push(...buildLvpUrls(color, collection));
    urls.push(...buildPorcelainUrls(color, collection, product_name, variant_name));
    urls.push(...buildMosaicUrls(color, collection, product_name, variant_name));
  }

  return [...new Set(urls)]; // deduplicate
}

// ─── Save image to DB ────────────────────────────────────────────────────────

async function saveImage(productId, skuId, url, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

// Reject marketing/promotional/ad images that are NOT product photos
function isMarketingImage(url) {
  const lower = url.toLowerCase();
  // Marketing feature images (soundproofing.jpg, aesthetic-appeal.jpg, versatile-use.jpg etc.)
  if (/\/(soundproofing|aesthetic|versatile|waterproof-icon|scratch|stain-resist|pet-?proof|click-?lock|acclimation|installation-guide|warranty|certification|greenguard|floorscore|quality|durability|benefits?|features?|comparison|why-choose|how-to|faq|flyer|brochure|infographic|banner|promo|advertisement|sale|discount|free-?sample|hero-?image)\b/i.test(lower)) return true;
  // Icon/badge/certification images
  if (/\/(icon|badge|logo|seal|stamp|cert|award|sprite|nav-|btn-|button|arrow|check-?mark|star-?rating)\b/i.test(lower)) return true;
  // MSI marketing directories
  if (/\/images\/(misc|miscellaneous|flyers|brochures|banners|marketing|ads|promos|downloads|catalogs|catalogues)\//i.test(lower)) return true;
  // MSI feature graphics under /flooring/w-{product}/ (e.g., /flooring/w-acousticwood/)
  if (/\/flooring\/w-/i.test(lower)) return true;
  return false;
}

// Classify image type from URL
function classifyImage(url) {
  if (url.includes('/iso/')) return { type: 'alternate', label: 'iso' };
  if (url.includes('/edge/')) return { type: 'alternate', label: 'edge' };
  if (url.includes('/roomscene')) return { type: 'lifestyle', label: 'room' };
  if (url.includes('/thumbnails/')) return { type: 'alternate', label: 'thumb' };
  return { type: 'primary', label: 'main' };
}

// Priority for sorting — lower = better candidate for primary image
// Goal: actual product photos (plank close-up, tile face) always come first
function getImagePriority(url, category) {
  const cat = (category || '').toLowerCase();
  const isLvp = /lvp|vinyl|spc|wpc|rigid|waterproof.*wood/i.test(cat);

  // Thumbnails always last — tiny/low-res versions
  if (url.includes('/thumbnails/')) return 100;
  // Room scenes
  if (url.includes('/roomscene')) return 95;
  // Edge detail shots
  if (url.includes('/edge/')) return 80;
  // ISO/angled floor views — not a product photo
  if (url.includes('/iso/')) return 70;

  // Category-specific detail images = BEST product photos
  if (url.includes('/lvt/detail/')) return 5;
  if (url.includes('/lvt/front/')) return 8;
  if (url.includes('/porcelainceramic/')) return 5;
  if (url.includes('/mosaics/')) return 5;
  if (url.includes('/hardscaping/detail/')) return 5;
  if (url.includes('/hardwood/detail/')) return 5;
  if (url.includes('/flooring/')) return 10;

  // For LVP: bare colornames/{color}.jpg = STAIR TREAD photos, NOT product
  if (isLvp && url.includes('/colornames/')) return 60;

  // For non-LVP: colornames = good product shots (tile face, stone slab)
  if (url.includes('/colornames/')) return 10;

  // Fallback
  return 20;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log(`MSI Re-Image${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log('═'.repeat(60));

  // Phase 0: Delete existing images
  if (!SKIP_DELETE && !DRY_RUN) {
    log('Phase 0: Deleting existing MSI images...');
    const { rowCount } = await pool.query(`
      DELETE FROM media_assets
      WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
    `, [VENDOR_ID]);
    log(`  Deleted ${rowCount} existing images`);
  } else if (SKIP_DELETE) {
    log('Phase 0: SKIPPED (--skip-delete)');
  }

  // Load all MSI SKUs
  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku,
           s.variant_name, s.variant_type,
           p.name AS product_name, p.collection,
           c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    ORDER BY p.collection, p.name, s.vendor_sku
  `, [VENDOR_ID]);

  log(`  Loaded ${skus.length} MSI SKUs`);

  // Load color attributes
  const colorMap = new Map();
  if (skus.length > 0) {
    const { rows: attrs } = await pool.query(`
      SELECT sa.sku_id, sa.value
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE a.slug = 'color' AND sa.sku_id = ANY($1)
    `, [skus.map(s => s.sku_id)]);
    attrs.forEach(a => colorMap.set(a.sku_id, a.value));
  }

  // Compute clean color name for each SKU
  for (const sku of skus) {
    const rawColor = colorMap.get(sku.sku_id) || sku.product_name;
    sku.color = extractColorName(rawColor, sku.collection);
  }

  // Group by category for reporting
  const byCat = {};
  for (const s of skus) {
    const cat = s.category || 'unknown';
    if (!byCat[cat]) byCat[cat] = 0;
    byCat[cat]++;
  }
  for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    log(`  ${cat}: ${count} SKUs`);
  }

  // Phase 1: CDN probing
  log('');
  log('Phase 1: CDN image probing...');

  let matched = 0, processed = 0;
  const total = skus.length;
  const matchedByType = { primary: 0, alternate: 0, lifestyle: 0 };

  for (const sku of skus) {
    processed++;
    if (processed % 100 === 0) {
      log(`  Progress: ${processed}/${total} (${matched} matched)`);
    }

    const candidates = buildAllUrls(sku);
    if (candidates.length === 0) continue;

    if (VERBOSE && processed <= 5) {
      log(`  Sample: ${sku.vendor_sku} color="${sku.color}" coll="${sku.collection}" cat="${sku.category}"`);
      candidates.slice(0, 5).forEach(u => log(`    ${u}`));
    }

    // Probe all candidates
    const hits = await probeAll(candidates);

    if (hits.length > 0) {
      // Filter out marketing/promotional images
      const goodHits = hits.filter(url => !isMarketingImage(url));
      if (goodHits.length === 0) continue;
      matched++;

      // Sort hits by priority — best product photo first
      const sorted = [...new Set(goodHits)]
        .map(url => ({ url, priority: getImagePriority(url, sku.category), ...classifyImage(url) }))
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 4);

      let sortOrder = 0;
      for (const img of sorted) {
        // First image is always primary; rest use their classified type
        const assetType = sortOrder === 0 ? 'primary' : img.type;
        await saveImage(sku.product_id, sku.sku_id, img.url, assetType, sortOrder);
        matchedByType[assetType] = (matchedByType[assetType] || 0) + 1;
        sortOrder++;
      }
    }
  }

  log(`  CDN matched: ${matched}/${total} SKUs (${(100 * matched / total).toFixed(1)}%)`);
  log(`  By type: ${JSON.stringify(matchedByType)}`);

  // Phase 2: Sibling inheritance
  log('');
  log('Phase 2: Sibling image inheritance...');
  const { rows: orphanSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
      AND EXISTS (
        SELECT 1 FROM skus sib
        JOIN media_assets ma ON ma.sku_id = sib.id
        WHERE sib.product_id = s.product_id AND sib.id != s.id
      )
  `, [VENDOR_ID]);

  let inherited = 0;
  for (const orphan of orphanSkus) {
    const { rows: sibImages } = await pool.query(`
      SELECT DISTINCT ON (ma.url) ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma
      JOIN skus sib ON sib.id = ma.sku_id
      WHERE sib.product_id = $1 AND sib.id != $2
      ORDER BY ma.url, ma.sort_order
      LIMIT 2
    `, [orphan.product_id, orphan.sku_id]);

    for (const img of sibImages) {
      await saveImage(orphan.product_id, orphan.sku_id, img.url, img.asset_type, img.sort_order);
    }
    if (sibImages.length > 0) inherited++;
  }

  log(`  Inherited images for ${inherited} SKUs from siblings`);

  // Phase 3: Show what's still missing
  log('');
  log('Phase 3: Coverage report...');
  const { rows: coverage } = await pool.query(`
    SELECT c.slug AS category,
           COUNT(DISTINCT s.id) AS total_skus,
           COUNT(DISTINCT s.id) FILTER (WHERE EXISTS (
             SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id
           )) AS with_images
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    GROUP BY c.slug
    ORDER BY COUNT(DISTINCT s.id) DESC
  `, [VENDOR_ID]);

  let totalSkus = 0, totalWithImages = 0;
  for (const row of coverage) {
    const pct = (100 * row.with_images / row.total_skus).toFixed(0);
    const missing = row.total_skus - row.with_images;
    log(`  ${row.category}: ${row.with_images}/${row.total_skus} (${pct}%) — ${missing} missing`);
    totalSkus += parseInt(row.total_skus);
    totalWithImages += parseInt(row.with_images);
  }

  // Show sample of still-missing SKUs
  const { rows: missingExamples } = await pool.query(`
    SELECT s.vendor_sku, p.name, p.collection, c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
    ORDER BY c.slug, p.collection, p.name
    LIMIT 20
  `, [VENDOR_ID]);

  if (missingExamples.length > 0) {
    log('');
    log('  Sample missing SKUs:');
    for (const ex of missingExamples) {
      log(`    ${ex.vendor_sku} — ${ex.name} (${ex.collection}) [${ex.category}]`);
    }
  }

  log('');
  log('═'.repeat(60));
  log(`  RESULTS`);
  log(`  CDN matched:       ${matched}`);
  log(`  Sibling inherited: ${inherited}`);
  log(`  Total SKUs:        ${totalSkus}`);
  log(`  With images:       ${totalWithImages} (${(100 * totalWithImages / totalSkus).toFixed(1)}%)`);
  log(`  Still missing:     ${totalSkus - totalWithImages}`);
  log(`  Time:              ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
