/**
 * MSI Fill Missing Images — Targeted CDN probing + direct URL construction
 *
 * ONLY processes SKUs that currently have zero images.
 * Does NOT delete anything.
 *
 * Strategy:
 *   1. CDN HEAD probing using known URL patterns (from msi-reimage.cjs)
 *   2. Direct MSI page fetch using constructed URLs from product name + category
 *   3. Sibling inheritance: copy images from same-product SKUs that DO have images
 *
 * Usage: node backend/scripts/msi-fill-missing.cjs [--dry-run] [--verbose]
 */

const { Pool } = require('pg');
const https = require('https');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const CDN = 'https://cdn.msisurfaces.com/images';
const BASE_URL = 'https://www.msisurfaces.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const CONCURRENCY = 20;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ─── HTTP HEAD ────────────────────────────────────────────────────────────────

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

function extractColorName(productName, collection) {
  let name = productName || '';
  if (collection) {
    const colLower = collection.toLowerCase();
    const nameLower = name.toLowerCase();
    if (nameLower.startsWith(colLower + ' ')) {
      name = name.slice(collection.length).trim();
    } else if (nameLower.startsWith(colLower)) {
      name = name.slice(collection.length).trim();
    }
  }
  name = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/g, '').trim();
  name = name.replace(/\s+(matte|polished|honed|glossy|satin|brushed|tumbled|textured|rectified)\s*$/i, '').trim();
  name = name.replace(/\s+(bullnose|pencil|chair\s*rail|quarter\s*round|mosaic|hexagon|herringbone|chevron)\s*$/i, '').trim();
  name = name.replace(/\s+(classic|premium|select|gauged)\s*$/i, '').trim();
  name = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/g, '').trim();
  name = name.replace(/^\d+\.?\d*\s+/i, '').trim();
  name = name.replace(/^(XL|XXL)\s+/i, '').trim();
  // Clean LVP noise
  name = name.replace(/^[-–—\s]+/, '').replace(/[-–—\s]+$/, '').trim();
  name = name.replace(/\s*\d+\.?\d*\s*x\s*\d+\.?\d*\s*/gi, ' ').trim();
  name = name.replace(/\s*[-–]\s*\d+\s*m+\b/gi, '').trim();
  name = name.replace(/\s*[-–]\s*\d+\s*mil\b/gi, '').trim();
  name = name.replace(/\s*[-–]\s*ac\b.*/i, '').trim();
  name = name.replace(/[-–]+\s*$/, '').trim();
  return name || productName;
}

// ─── URL Builders (ported from msi-reimage.cjs) ─────────────────────────────

function buildColorNameUrls(color, collection, productName) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);
  const urls = [];
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/colornames/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/colornames/${collSlug}-${colorSlug}.jpg`,
      `${CDN}/colornames/iso/${colorSlug}-${collSlug}-iso.jpg`,
      `${CDN}/colornames/edge/${colorSlug}-${collSlug}-edge.jpg`,
    );
  }
  if (colorSlug) {
    urls.push(`${CDN}/colornames/${colorSlug}.jpg`);
  }
  if (nameSlug && nameSlug !== colorSlug) {
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }
  return urls;
}

function buildLvpUrls(color, collection, vendorSku) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const urls = [];

  if (colorSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/iso/${colorSlug}-vinyl-flooring-iso.jpg`,
    );
  }
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}-${collSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/lvt/detail/xl-${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
      `${CDN}/lvt/detail/xxl-${collSlug}-${colorSlug}-vinyl-flooring.jpg`,
    );
    const baseCollSlug = collSlug.replace(/^xl-/, '').replace(/^xxl-/, '');
    if (baseCollSlug === 'cyrus' || baseCollSlug === 'prescott') {
      urls.push(
        `${CDN}/lvt/detail/${colorSlug}-${baseCollSlug}-2.0-vinyl-flooring.jpg`,
        `${CDN}/lvt/detail/${baseCollSlug}-2-${colorSlug}-vinyl-flooring.jpg`,
      );
    }
  }
  return urls;
}

function buildPorcelainUrls(color, collection, productName, variantName) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);
  const urls = [];
  const colorAlt = colorSlug.replace(/grey/g, 'gray');
  const nameAlt = nameSlug.replace(/grey/g, 'gray');
  const colorSlugs = [colorSlug];
  if (colorAlt !== colorSlug) colorSlugs.push(colorAlt);
  const nameSlugs = [nameSlug];
  if (nameAlt !== nameSlug) nameSlugs.push(nameAlt);

  if (colorSlug && collSlug) {
    for (const cs of colorSlugs) {
      urls.push(
        `${CDN}/porcelainceramic/${cs}-${collSlug}-porcelain.jpg`,
        `${CDN}/porcelainceramic/${collSlug}-${cs}-porcelain.jpg`,
        `${CDN}/porcelainceramic/${cs}-${collSlug}.jpg`,
      );
    }
  }
  const sizeMatch = (variantName || '').match(/(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);
  if (sizeMatch && nameSlug) {
    const size = `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase();
    for (const ns of nameSlugs) {
      urls.push(
        `${CDN}/porcelainceramic/${ns}-${size}.jpg`,
        `${CDN}/porcelainceramic/${ns}.jpg`,
      );
    }
  }
  if (nameSlug) {
    for (const ns of nameSlugs) {
      urls.push(
        `${CDN}/porcelainceramic/${ns}.jpg`,
        `${CDN}/colornames/${ns}.jpg`,
      );
    }
  }
  return urls;
}

function buildMosaicUrls(color, collection, productName, variantName) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const nameSlug = slugify(productName);
  const shortName = (productName || '')
    .replace(/\s+\d+x\d+.*$/i, '')
    .replace(/\s+(mesh\s*backed|polished|glossy|matte|honed|tumbled)\s*$/i, '')
    .trim();
  const shortSlug = slugify(shortName);
  const sizeMatch = (variantName || '').match(/(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);
  const sizeStr = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase() : null;

  const urls = [
    `${CDN}/mosaics/${nameSlug}.jpg`,
    `${CDN}/mosaics/${shortSlug}.jpg`,
  ];
  if (sizeStr && nameSlug) {
    urls.push(`${CDN}/mosaics/${nameSlug}-${sizeStr}.jpg`);
  }
  if (sizeStr && shortSlug && shortSlug !== nameSlug) {
    urls.push(`${CDN}/mosaics/${shortSlug}-${sizeStr}.jpg`);
  }
  urls.push(
    `${CDN}/mosaics/iso/${nameSlug}-iso.jpg`,
    `${CDN}/backsplash/${nameSlug}.jpg`,
    `${CDN}/backsplash/${shortSlug}.jpg`,
    `${CDN}/wallpanels/${nameSlug}.jpg`,
    `${CDN}/wallpanels/${shortSlug}.jpg`,
  );
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/mosaics/${colorSlug}-${collSlug}.jpg`,
      `${CDN}/mosaics/${collSlug}-${colorSlug}.jpg`,
    );
  }
  if (colorSlug) {
    urls.push(`${CDN}/mosaics/${colorSlug}.jpg`);
  }
  return urls;
}

function buildStackedStoneUrls(color, collection, productName) {
  const nameSlug = slugify(productName);
  const coreName = (productName || '')
    .replace(/\s*(panel|corner|corners|wht corner|mfd stacked stones corner)\s*$/i, '')
    .trim();
  const coreSlug = slugify(coreName);
  const baseName = coreName
    .replace(/\s*(rockmount|splitface|split\s+face|ledgestone|ledger|sq\s*rec|stacked|mosaic|flats?|veneer|fieldstone|mini\s*panel)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const baseSlug = slugify(baseName);

  return [
    `${CDN}/hardscaping/detail/${coreSlug}-stacked-stone-panels.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}-stacked-stone-panels.jpg`,
    `${CDN}/hardscaping/detail/${coreSlug}-fieldstone.jpg`,
    `${CDN}/hardscaping/detail/${coreSlug}.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}-veneer-fieldstone.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}-fieldstone.jpg`,
    `${CDN}/hardscaping/${nameSlug}.jpg`,
    `${CDN}/stackedstone/${nameSlug}.jpg`,
    `${CDN}/stackedstone/${coreSlug}.jpg`,
    `${CDN}/stackedstone/${baseSlug}.jpg`,
    // Ledger-specific patterns
    `${CDN}/hardscaping/detail/${baseSlug}-ledger-panel.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}-multi-ledger-panel.jpg`,
    `${CDN}/hardscaping/detail/${baseSlug}-mini-panel.jpg`,
    // Corner-specific patterns
    `${CDN}/hardscaping/variations/${coreSlug}-stacked-stone-panels-corner2.jpg`,
    `${CDN}/hardscaping/variations/${baseSlug}-stacked-stone-panels-corner2.jpg`,
  ];
}

function buildNaturalStoneUrls(color, collection, productName) {
  const nameSlug = slugify(productName);
  const colorSlug = slugify(color);
  const coreName = (productName || '')
    .replace(/\s+\d+x\d+.*$/i, '')
    .replace(/\s+(gauged|polished|honed|tumbled|brushed|filled|unfilled|hon\s+bev|splitface)\s*$/i, '')
    .replace(/\s+(peel and stick|veneer|mosaic|pencil|picket|pickett)\s*$/i, '')
    .trim();
  const coreSlug = slugify(coreName);
  const stoneTypes = ['marble', 'travertine', 'granite', 'limestone', 'slate', 'quartzite', 'sandstone', 'onyx'];

  const urls = [];
  for (const type of stoneTypes) {
    urls.push(`${CDN}/colornames/${colorSlug}-${type}.jpg`);
    if (coreSlug !== colorSlug) urls.push(`${CDN}/colornames/${coreSlug}-${type}.jpg`);
  }
  urls.push(
    `${CDN}/mosaics/${nameSlug}.jpg`,
    `${CDN}/mosaics/${coreSlug}.jpg`,
    `${CDN}/naturalstone/${nameSlug}.jpg`,
    `${CDN}/naturalstone/${coreSlug}.jpg`,
    `${CDN}/hardscaping/detail/${nameSlug}.jpg`,
  );
  return urls;
}

function buildHardwoodUrls(color, collection) {
  const colorSlug = slugify(color);
  const collSlug = slugify(collection);
  const urls = [];
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-${collSlug}.jpg`,
    );
  }
  if (colorSlug) {
    urls.push(
      `${CDN}/lvt/detail/${colorSlug}-hardwood-flooring.jpg`,
      `${CDN}/lvt/detail/${colorSlug}-engineered-hardwood-flooring.jpg`,
    );
  }
  if (colorSlug && collSlug) {
    urls.push(
      `${CDN}/hardwood/detail/${collSlug}-${colorSlug}-hardwood-flooring.jpg`,
      `${CDN}/hardwood/detail/${colorSlug}-${collSlug}-hardwood-flooring.jpg`,
      `${CDN}/hardwood/detail/${collSlug}-${colorSlug}.jpg`,
    );
  }
  return urls;
}

function buildAllUrls(sku) {
  const { category, collection, product_name, color, vendor_sku, variant_name } = sku;
  const cat = (category || '').toLowerCase();
  const urls = [];
  urls.push(...buildColorNameUrls(color, collection, product_name));
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
    urls.push(...buildHardwoodUrls(color, collection));
    urls.push(...buildLvpUrls(color, collection, vendor_sku));
  } else {
    urls.push(...buildLvpUrls(color, collection));
    urls.push(...buildPorcelainUrls(color, collection, product_name, variant_name));
    urls.push(...buildMosaicUrls(color, collection, product_name, variant_name));
  }
  return [...new Set(urls)];
}

// ─── Image priority / classification ─────────────────────────────────────────

function getImagePriority(url, category) {
  const cat = (category || '').toLowerCase();
  const isLvp = /lvp|vinyl|spc|wpc|rigid|waterproof.*wood/i.test(cat);
  if (url.includes('/thumbnails/')) return 100;
  if (url.includes('/roomscene')) return 95;
  if (url.includes('/edge/')) return 80;
  if (url.includes('/iso/')) return 70;
  if (url.includes('/lvt/detail/')) return 5;
  if (url.includes('/porcelainceramic/')) return 5;
  if (url.includes('/mosaics/')) return 5;
  if (url.includes('/hardscaping/detail/')) return 5;
  if (url.includes('/hardwood/detail/')) return 5;
  if (isLvp && url.includes('/colornames/')) return 60;
  if (url.includes('/colornames/')) return 10;
  return 20;
}

function isMarketingImage(url) {
  const lower = url.toLowerCase();
  if (/\/(soundproofing|aesthetic|versatile|waterproof-icon|scratch|stain-resist|pet-?proof|click-?lock|acclimation|installation-guide|warranty|certification|greenguard|floorscore|quality|durability|benefits?|features?|comparison|why-choose|how-to|faq|flyer|brochure|infographic|banner|promo|advertisement|sale|discount|free-?sample|hero-?image)\b/i.test(lower)) return true;
  if (/\/(icon|badge|logo|seal|stamp|cert|award|sprite|nav-|btn-|button|arrow|check-?mark|star-?rating)\b/i.test(lower)) return true;
  if (/\/images\/(misc|miscellaneous|flyers|brochures|banners|marketing|ads|promos|downloads|catalogs|catalogues|svg|trends|home)\//i.test(lower)) return true;
  if (/\/flooring\/w-/i.test(lower)) return true;
  // Generic page chrome from MSI website
  if (/\/(backsplash-redesign|stacked-stone-installation|installation-instructions|videos|slider|popup|new-branding)\//i.test(lower)) return true;
  if (/expansive-selection|subway-mosaics|inspiration-gallery/i.test(lower)) return true;
  // SVG and video files
  if (/\.(svg|mp4|webm)(\?|$)/i.test(lower)) return true;
  return false;
}

// Check if URL is from a known product-photo CDN directory
function isProductPhotoUrl(url) {
  const lower = url.toLowerCase();
  return /\/(lvt|porcelainceramic|mosaics|hardscaping|hardwood|naturalstone|stackedstone|colornames|backsplash|wallpanels)\//i.test(lower)
    && !isMarketingImage(url);
}

async function saveImage(productId, skuId, url, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

// ─── Fetch helpers for Phase 2 ──────────────────────────────────────────────

async function fetchHtml(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
      });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      if (i === retries) return null;
      await delay(1000);
    }
  }
  return null;
}

function extractImagesFromHtml(html) {
  const images = [];
  const seen = new Set();
  function addImg(src) {
    if (!src) return;
    if (!src.includes('cdn.msisurfaces.com')) return;
    if (/\.(svg|gif|ico|mp4|webm)(\?|$)/i.test(src)) return;
    if (/icon|logo|badge|placeholder|miscellaneous|flyers|brochures|roomvo|wetcutting|trends|new-branding/i.test(src)) return;
    src = src.replace(/&amp;/g, '&').trim();
    if (seen.has(src)) return;
    seen.add(src);
    // STRICT: only keep images from known product-photo CDN directories
    if (isProductPhotoUrl(src)) images.push(src);
  }

  // og:image
  const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) addImg(ogMatch[1]);

  // JSON-LD
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const d = JSON.parse(ldMatch[1]);
      const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
      imgs.forEach(addImg);
    } catch {}
  }

  // img tags
  const imgRegex = /<img[^>]+(?:src|data-src)=["']([^"']*cdn\.msisurfaces\.com[^"']*)["']/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) addImg(imgMatch[1]);

  // Any CDN URLs
  const cdnRegex = /https?:\/\/cdn\.msisurfaces\.com\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi;
  let cdnMatch;
  while ((cdnMatch = cdnRegex.exec(html)) !== null) addImg(cdnMatch[0]);

  return images;
}

// ─── Build website URLs to try for a product ────────────────────────────────

function buildWebsiteUrls(productName, category, collection) {
  const cat = (category || '').toLowerCase();
  const nameSlug = slugify(extractColorName(productName, collection));
  const fullSlug = slugify(productName);

  // Also try the cleaned product name
  const cleaned = (productName || '')
    .replace(/^[-–—\s]+/, '')
    .replace(/\s*\d+\.?\d*\s*x\s*\d+\.?\d*\s*/gi, ' ')
    .replace(/\s*[-–]\s*\d+\s*m+\b/gi, '')
    .replace(/\s*[-–]\s*\d+\s*mil\b/gi, '')
    .replace(/\s*[-–]\s*ac\b.*/i, '')
    .replace(/[-–]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanSlug = slugify(cleaned);

  const urls = [];
  const slugVariants = [...new Set([nameSlug, fullSlug, cleanSlug].filter(Boolean))];

  if (/lvp|vinyl/i.test(cat)) {
    for (const s of slugVariants) {
      urls.push(`${BASE_URL}/luxury-vinyl-planks/${s}/`);
      urls.push(`${BASE_URL}/luxury-vinyl-flooring/${s}/`);
      urls.push(`${BASE_URL}/waterproof-hybrid-rigid-core/${s}/`);
    }
    // For LVP collection pages
    if (collection) {
      const collSlug = slugify(collection);
      urls.push(`${BASE_URL}/luxury-vinyl-planks/${collSlug}/`);
      urls.push(`${BASE_URL}/luxury-vinyl-planks/${collSlug}/${nameSlug}/`);
    }
  } else if (/porcelain|ceramic/i.test(cat)) {
    for (const s of slugVariants) {
      urls.push(`${BASE_URL}/porcelain-tile/${s}/`);
      urls.push(`${BASE_URL}/wood-look-tile-and-planks/${s}/`);
      urls.push(`${BASE_URL}/large-format-tile/${s}/`);
    }
  } else if (/mosaic|backsplash/i.test(cat)) {
    for (const s of slugVariants) {
      urls.push(`${BASE_URL}/backsplash-tile/${s}/`);
      urls.push(`${BASE_URL}/mosaics/${s}/`);
      urls.push(`${BASE_URL}/backsplash-tile/mosaic-tile/${s}/`);
      urls.push(`${BASE_URL}/backsplash-tile/glass-tile/${s}/`);
    }
  } else if (/stacked.*stone|ledger/i.test(cat)) {
    for (const s of slugVariants) {
      urls.push(`${BASE_URL}/hardscape/rockmount-stacked-stone/${s}/`);
      urls.push(`${BASE_URL}/hardscape/${s}/`);
    }
  } else if (/natural.*stone|marble|granite|travertine/i.test(cat)) {
    for (const s of slugVariants) {
      urls.push(`${BASE_URL}/marble-tile/${s}/`);
      urls.push(`${BASE_URL}/travertine-tile/${s}/`);
      urls.push(`${BASE_URL}/granite-tile/${s}/`);
      urls.push(`${BASE_URL}/natural-stone-tile/${s}/`);
    }
  } else if (/hardwood|engineered/i.test(cat)) {
    for (const s of slugVariants) {
      urls.push(`${BASE_URL}/w-luxury-genuine-hardwood/${s}/`);
    }
  }
  return [...new Set(urls)];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log('MSI Fill Missing Images');
  log('═'.repeat(60));
  if (DRY_RUN) log('DRY RUN — no DB writes');

  // ── Load ONLY SKUs missing images ──
  log('Phase 0: Loading SKUs missing images...');
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

  // Load color attributes
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
    sku.color = extractColorName(rawColor, sku.collection);
  }

  // Group by product for efficiency (probe once per product, apply to all SKUs)
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
  for (const p of products) {
    const cat = p.category || 'unknown';
    byCat[cat] = (byCat[cat] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    log(`    ${cat}: ${count} products`);
  }

  // ── Phase 1: CDN HEAD Probing ──
  log('');
  log('Phase 1: CDN image probing...');
  let cdnMatched = 0, cdnImages = 0;

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    if ((i + 1) % 50 === 0 || i === products.length - 1) {
      log(`  Progress: ${i + 1}/${products.length} (${cdnMatched} matched, ${cdnImages} images)`);
    }

    // Use the first SKU's data for URL building (color may differ per SKU, but product-level images are shared)
    const sku = product.skus[0];
    const candidates = buildAllUrls(sku);
    if (candidates.length === 0) continue;

    const hits = await probeAll(candidates);
    if (hits.length === 0) continue;

    // Sort by priority, take best 4
    const sorted = hits
      .map(url => ({ url, pri: getImagePriority(url, product.category) }))
      .sort((a, b) => a.pri - b.pri)
      .slice(0, 4);

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
      log(`    ✓ ${product.product_name} [${product.category}] → ${sorted.length} images`);
    }
  }

  log(`  CDN probing done: ${cdnMatched} products matched, ${cdnImages} images saved`);

  // ── Phase 2: Direct Website Page Fetch for remaining ──
  const stillMissing = products.filter(p => !p._resolved);
  log('');
  log(`Phase 2: Website page fetch for ${stillMissing.length} remaining products...`);
  let webMatched = 0, webImages = 0;

  for (let i = 0; i < stillMissing.length; i++) {
    const product = stillMissing[i];
    if ((i + 1) % 25 === 0 || i === stillMissing.length - 1) {
      log(`  Progress: ${i + 1}/${stillMissing.length} (${webMatched} matched, ${webImages} images)`);
    }

    const websiteUrls = buildWebsiteUrls(product.product_name, product.category, product.collection);
    if (websiteUrls.length === 0) continue;

    let foundImages = null;

    for (const pageUrl of websiteUrls) {
      const html = await fetchHtml(pageUrl);
      if (!html || html.length < 5000) continue; // Too short = redirect/error page

      const images = extractImagesFromHtml(html);
      if (images.length > 0) {
        foundImages = images;
        if (VERBOSE) log(`    Found via ${pageUrl}`);
        break;
      }
      await delay(500); // Be polite
    }

    if (foundImages && foundImages.length > 0) {
      const sorted = foundImages
        .map(url => ({
          url: url.replace('/thumbnails/', '/detail/'),
          pri: getImagePriority(url, product.category)
        }))
        .sort((a, b) => a.pri - b.pri)
        .slice(0, 4);

      webMatched++;
      product._resolved = true;

      for (const sku of product.skus) {
        let sortOrder = 0;
        for (const img of sorted) {
          const assetType = sortOrder === 0 ? 'primary' : 'alternate';
          await saveImage(product.product_id, sku.sku_id, img.url, assetType, sortOrder);
          webImages++;
          sortOrder++;
        }
      }
    }

    await delay(300);
  }

  log(`  Website fetch done: ${webMatched} products matched, ${webImages} images saved`);

  // ── Phase 3: Sibling inheritance for remaining ──
  const stillMissing2 = products.filter(p => !p._resolved);
  log('');
  log(`Phase 3: Sibling inheritance for ${stillMissing2.length} remaining products...`);
  let siblingMatched = 0, siblingImages = 0;

  // Check if any of these products have sibling SKUs (same product) that got images
  // (This handles the case where CDN/web matched some but not all SKUs of a product)
  // But since we process per-product, this won't help here.
  // Instead, check if there's a product with a SIMILAR name that has images.
  // E.g., "Arabescato Carrara 2x2 Mosaic" might share images with "Arabescato Carrara"

  for (const product of stillMissing2) {
    // Extract base name (strip size, format, mosaic/bullnose suffix)
    const baseName = (product.product_name || '')
      .replace(/^[-–—\s]+/, '')
      .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/i, '')
      .replace(/\s+(mosaic|bullnose|pencil|hexagon|herringbone|chevron|2x2|2x4|3x6|3x12|3x18|4x12|6x12|6x24|12x24|picket|pickett)\s*$/i, '')
      .replace(/\s+(interlocking|3d|peel\s+and\s+stick|mesh\s+backed|veneer)\s*$/i, '')
      .replace(/\s+(honed\s+and\s+beveled|hon\s+bev)\s*$/i, '')
      .replace(/\s*\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!baseName || baseName.length < 3) continue;

    const { rows: siblings } = await pool.query(`
      SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
      FROM products p
      JOIN skus s ON s.product_id = p.id
      JOIN media_assets ma ON ma.sku_id = s.id
      WHERE p.vendor_id = $1
        AND p.id != $2
        AND LOWER(p.name) LIKE $3
      ORDER BY ma.sort_order
      LIMIT 4
    `, [VENDOR_ID, product.product_id, baseName.toLowerCase() + '%']);

    if (siblings.length > 0) {
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

      if (VERBOSE) {
        log(`    ✓ ${product.product_name} → inherited from "${baseName}..." (${siblings.length} images)`);
      }
    }
  }

  log(`  Sibling inheritance done: ${siblingMatched} products matched, ${siblingImages} images saved`);

  // ── Final Report ──
  log('');
  log('Phase 4: Coverage report...');
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
    log(`  ${row.category || '(none)'}: ${row.with_images}/${row.total_skus} (${pct}%) — ${missing} missing`);
    totalSkus += parseInt(row.total_skus);
    totalWithImages += parseInt(row.with_images);
  }

  // List remaining unresolved products
  const unresolved = products.filter(p => !p._resolved);
  if (unresolved.length > 0 && unresolved.length <= 50) {
    log('');
    log(`Unresolved products (${unresolved.length}):`);
    for (const p of unresolved) {
      const skuList = p.skus.map(s => s.vendor_sku).join(', ');
      log(`  [${p.category}] ${p.product_name} — ${skuList}`);
    }
  }

  log('');
  log('═'.repeat(60));
  log(`  RESULTS`);
  log(`  CDN probed:     ${cdnMatched} products (${cdnImages} images)`);
  log(`  Website fetch:  ${webMatched} products (${webImages} images)`);
  log(`  Sibling inherit: ${siblingMatched} products (${siblingImages} images)`);
  log(`  Total matched:  ${cdnMatched + webMatched + siblingMatched} / ${products.length} products`);
  log(`  Total SKUs:     ${totalSkus}`);
  log(`  With images:    ${totalWithImages} (${(100 * totalWithImages / totalSkus).toFixed(1)}%)`);
  log(`  Still missing:  ${totalSkus - totalWithImages}`);
  log(`  Time:           ${Math.round((Date.now() - startTime) / 1000)}s`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
