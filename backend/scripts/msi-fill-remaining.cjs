/**
 * MSI Fill Remaining — Targeted second pass for the last ~44 unresolved products.
 *
 * Uses smarter slug generation: strips sizes, "3d", "Lappatpo", "Bullnose",
 * format suffixes, and tries multiple slug truncations to find MSI pages.
 * Also tries collection-based pages (/porcelain-tile/{collection}/) and sub-page following.
 *
 * Usage: node backend/scripts/msi-fill-remaining.cjs [--dry-run] [--verbose]
 */

const { Pool } = require('pg');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const BASE_URL = 'https://www.msisurfaces.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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

async function fetchHtml(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
      });
      if (!resp.ok) return null;
      const text = await resp.text();
      // Check for redirect to homepage (MSI returns 200 but homepage content)
      if (text.length < 5000) return null;
      return text;
    } catch {
      if (i === retries) return null;
      await delay(1000);
    }
  }
  return null;
}

function isMarketingImage(url) {
  const lower = url.toLowerCase();
  if (/\/(soundproofing|aesthetic|versatile|waterproof-icon|scratch|stain-resist|pet-?proof|click-?lock|installation|warranty|certification|greenguard|floorscore|features?|comparison|how-to|faq|flyer|brochure|infographic|banner|promo|sale|discount|hero-?image)\b/i.test(lower)) return true;
  if (/\/(icon|badge|logo|seal|stamp|cert|award|sprite|nav-|btn-|button|arrow|check-?mark|star-?rating)\b/i.test(lower)) return true;
  if (/\/images\/(misc|miscellaneous|flyers|brochures|banners|marketing|ads|promos|downloads|svg|trends|home)\//i.test(lower)) return true;
  if (/\/flooring\/w-/i.test(lower)) return true;
  if (/\/(backsplash-redesign|stacked-stone-installation|installation-instructions|videos|slider|popup|new-branding)\//i.test(lower)) return true;
  if (/expansive-selection|subway-mosaics|inspiration-gallery/i.test(lower)) return true;
  if (/\.(svg|mp4|webm)(\?|$)/i.test(lower)) return true;
  return false;
}

function isProductPhotoUrl(url) {
  const lower = url.toLowerCase();
  return /\/(lvt|porcelainceramic|mosaics|hardscaping|hardwood|naturalstone|stackedstone|colornames|backsplash|wallpanels)\//i.test(lower)
    && !isMarketingImage(url);
}

function extractImagesFromHtml(html) {
  const images = [];
  const seen = new Set();
  function addImg(src) {
    if (!src || !src.includes('cdn.msisurfaces.com')) return;
    if (/\.(svg|gif|ico|mp4|webm)(\?|$)/i.test(src)) return;
    if (/icon|logo|badge|placeholder|miscellaneous|flyers|brochures|roomvo|wetcutting|trends|new-branding/i.test(src)) return;
    src = src.replace(/&amp;/g, '&').trim();
    if (seen.has(src)) return;
    seen.add(src);
    if (isProductPhotoUrl(src)) images.push(src);
  }

  const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) addImg(ogMatch[1]);

  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const d = JSON.parse(ldMatch[1]);
      const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
      imgs.forEach(addImg);
    } catch {}
  }

  const imgRegex = /<img[^>]+(?:src|data-src)=["']([^"']*cdn\.msisurfaces\.com[^"']*)["']/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) addImg(imgMatch[1]);

  const cdnRegex = /https?:\/\/cdn\.msisurfaces\.com\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi;
  let cdnMatch;
  while ((cdnMatch = cdnRegex.exec(html)) !== null) addImg(cdnMatch[0]);

  return images;
}

function getImagePriority(url, category) {
  if (url.includes('/thumbnails/')) return 100;
  if (url.includes('/roomscene')) return 95;
  if (url.includes('/edge/')) return 80;
  if (url.includes('/iso/')) return 70;
  if (url.includes('/lvt/detail/')) return 5;
  if (url.includes('/porcelainceramic/')) return 5;
  if (url.includes('/mosaics/')) return 5;
  if (url.includes('/hardscaping/detail/')) return 5;
  return 20;
}

// Generate all possible URL slugs from a product name
function generateSlugs(productName) {
  const name = (productName || '').trim();
  const slugs = new Set();

  // Full name
  slugs.add(slugify(name));

  // Strip trailing sizes like "24x48", "12x24", "7x16", "8x8", "13x13", "17x17", "10x60"
  const noSize = name
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/i, '')
    .trim();
  slugs.add(slugify(noSize));

  // Strip common suffixes: 3d, Lappatpo/Lappato, Bullnose, Mosaic, Pencil, etc.
  const noSuffix = noSize
    .replace(/\s+(3d|lappatpo|lappato|bullnose|mosaic|pencil|hexagon|herringbone|chevron|honed\s+and\s+beveled|hon\s+bev|peel\s+and\s+stick|veneer|mesh\s+backed|interlocking)\s*$/i, '')
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/i, '')
    .trim();
  slugs.add(slugify(noSuffix));

  // Strip color suffixes for collection pages
  // E.g., "Elbe Alabaster" → "Elbe", "Country River Bark" → "Country River"
  const words = noSuffix.split(/\s+/);
  if (words.length >= 2) {
    // Try progressively shorter prefixes
    for (let i = words.length - 1; i >= 1; i--) {
      slugs.add(slugify(words.slice(0, i).join(' ')));
    }
  }

  // Strip leading dashes/special chars
  const cleaned = name.replace(/^[-–—\s]+/, '').trim();
  if (cleaned !== name) {
    slugs.add(slugify(cleaned));
    // Apply same suffix stripping
    const cleanedNoSize = cleaned.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/i, '').trim();
    slugs.add(slugify(cleanedNoSize));
  }

  slugs.delete('');
  return [...slugs];
}

// Build all possible MSI website URLs to try
function buildWebsiteUrls(productName, category) {
  const cat = (category || '').toLowerCase();
  const slugs = generateSlugs(productName);
  const urls = [];

  // Category path prefixes to try
  const catPaths = [];
  if (/porcelain|ceramic/i.test(cat)) {
    catPaths.push('/porcelain-tile/', '/wood-look-tile-and-planks/', '/large-format-tile/');
  } else if (/natural.*stone|marble|granite|travertine/i.test(cat)) {
    catPaths.push('/marble-tile/', '/travertine-tile/', '/granite-tile/', '/limestone-tile/');
  } else if (/stacked.*stone/i.test(cat)) {
    catPaths.push('/hardscape/rockmount-stacked-stone/');
  } else if (/mosaic/i.test(cat)) {
    catPaths.push('/backsplash-tile/', '/mosaics/');
  } else {
    catPaths.push('/porcelain-tile/', '/marble-tile/');
  }

  for (const catPath of catPaths) {
    for (const slug of slugs) {
      if (slug.length < 3) continue;
      urls.push(`${BASE_URL}${catPath}${slug}/`);
    }
  }

  return [...new Set(urls)];
}

// Extract sub-product links from a collection page
function extractSubProductLinks(html, pageUrl) {
  const links = [];
  const seen = new Set();
  const linkRegex = /<a[^>]+href=["'](\/[^"']+|https?:\/\/www\.msisurfaces\.com\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  const currentPath = (() => {
    const m = pageUrl.match(/msisurfaces\.com(\/[^?#]*)/);
    return m ? m[1] : '';
  })();
  const currentSegments = currentPath.split('/').filter(Boolean);

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    try {
      let href = match[1];
      const linkText = match[2].replace(/<[^>]+>/g, '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
      if (href.startsWith('/')) href = BASE_URL + href;
      if (!href.includes('msisurfaces.com')) continue;

      const pathM = href.match(/msisurfaces\.com(\/[^?#"']*)/);
      if (!pathM) continue;
      const path = pathM[1];
      const segments = path.split('/').filter(Boolean);
      if (segments.length <= currentSegments.length) continue;
      if (segments.length < 3) continue;

      const colorSlug = segments[segments.length - 1];
      if (/site-search|cart|account|contact|filter|sort|page|resources/i.test(colorSlug)) continue;
      if (/\.(jpg|png|css|js|pdf)$/i.test(colorSlug)) continue;

      const fullUrl = BASE_URL + path;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);
      links.push({ href: fullUrl, colorSlug, colorName: linkText });
    } catch {}
  }
  return links;
}

async function saveImage(productId, skuId, url, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log('MSI Fill Remaining — Second Pass');
  log('═'.repeat(60));
  if (DRY_RUN) log('DRY RUN — no DB writes');

  // Load only products with ZERO images
  const { rows: missingSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku,
           s.variant_name, p.name AS product_name, p.collection,
           c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
    ORDER BY c.slug, p.name
  `, [VENDOR_ID]);

  log(`  ${missingSkus.length} SKUs still missing images`);

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

  // Track pages we've already fetched (avoid refetching collection pages)
  const pageCache = new Map();

  async function fetchCached(url) {
    if (pageCache.has(url)) return pageCache.get(url);
    const html = await fetchHtml(url);
    pageCache.set(url, html);
    return html;
  }

  let matched = 0, totalImages = 0;

  for (const product of products) {
    const websiteUrls = buildWebsiteUrls(product.product_name, product.category);

    if (VERBOSE) {
      log(`  Trying: ${product.product_name} [${product.category}]`);
      log(`    Slugs: ${generateSlugs(product.product_name).join(', ')}`);
    }

    let foundImages = null;

    for (const pageUrl of websiteUrls) {
      const html = await fetchCached(pageUrl);
      if (!html) continue;

      // First try: direct images from this page
      const images = extractImagesFromHtml(html);
      if (images.length > 0) {
        // Check if this is a collection page with sub-products
        const subLinks = extractSubProductLinks(html, pageUrl);

        if (subLinks.length > 0) {
          // This is a collection page — try to find the specific color sub-page
          const productNameSlug = slugify(product.product_name);
          const nameSlugs = generateSlugs(product.product_name);

          // Try to match a sub-link to this specific product
          let bestSub = null;
          for (const sub of subLinks) {
            // Check if the sub-page slug matches any of our name slugs
            for (const ns of nameSlugs) {
              if (sub.colorSlug === ns || sub.href.includes('/' + ns + '/')) {
                bestSub = sub;
                break;
              }
            }
            if (bestSub) break;

            // Also check link text
            const linkSlug = slugify(sub.colorName);
            for (const ns of nameSlugs) {
              if (linkSlug === ns || linkSlug.includes(ns) || ns.includes(linkSlug)) {
                bestSub = sub;
                break;
              }
            }
            if (bestSub) break;
          }

          if (bestSub) {
            // Fetch the specific sub-page
            const subHtml = await fetchCached(bestSub.href);
            if (subHtml) {
              const subImages = extractImagesFromHtml(subHtml);
              if (subImages.length > 0) {
                foundImages = subImages;
                if (VERBOSE) log(`    ✓ Found via sub-page: ${bestSub.href}`);
                break;
              }
            }
          }

          // If no specific sub-match, use the collection page images as fallback
          foundImages = images;
          if (VERBOSE) log(`    ✓ Using collection page: ${pageUrl}`);
          break;
        } else {
          // Direct product page with images
          foundImages = images;
          if (VERBOSE) log(`    ✓ Found via: ${pageUrl}`);
          break;
        }
      }

      await delay(400);
    }

    if (foundImages && foundImages.length > 0) {
      const sorted = foundImages
        .map(url => ({
          url: url.replace('/thumbnails/', '/detail/'),
          pri: getImagePriority(url, product.category)
        }))
        .sort((a, b) => a.pri - b.pri)
        .slice(0, 4);

      matched++;

      for (const sku of product.skus) {
        let sortOrder = 0;
        for (const img of sorted) {
          const assetType = sortOrder === 0 ? 'primary' : 'alternate';
          await saveImage(product.product_id, sku.sku_id, img.url, assetType, sortOrder);
          totalImages++;
          sortOrder++;
        }
      }
    } else if (VERBOSE) {
      log(`    ✗ No images found`);
    }

    await delay(300);
  }

  // Now try sibling inheritance for any still-unresolved
  log('');
  log('Sibling inheritance pass...');
  const { rows: stillMissing } = await pool.query(`
    SELECT DISTINCT p.id AS product_id, p.name
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
  `, [VENDOR_ID]);

  let sibMatched = 0;
  for (const prod of stillMissing) {
    // Strip everything after the core name to find related products
    const baseName = (prod.name || '')
      .replace(/^[-–—\s]+/, '')
      .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*.*$/i, '')
      .replace(/\s+(3d|lappatpo|lappato|bullnose|mosaic|pencil|hexagon|herringbone|chevron|interlocking|peel\s+and\s+stick|veneer|mesh\s+backed|honed\s+and\s+beveled|hon\s+bev)\s*$/i, '')
      .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*.*$/i, '')
      .trim();

    if (!baseName || baseName.length < 3) continue;

    // Find related products with images
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
    `, [VENDOR_ID, prod.product_id, baseName.toLowerCase() + '%']);

    if (siblings.length > 0) {
      // Get all SKUs for this product
      const { rows: skus } = await pool.query(`
        SELECT id FROM skus WHERE product_id = $1 AND status = 'active'
          AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = skus.id)
      `, [prod.product_id]);

      for (const sku of skus) {
        let sortOrder = 0;
        for (const img of siblings) {
          const assetType = sortOrder === 0 ? 'primary' : 'alternate';
          await saveImage(prod.product_id, sku.id, img.url, assetType, sortOrder);
          totalImages++;
          sortOrder++;
        }
      }
      sibMatched++;
      if (VERBOSE) log(`  ✓ ${prod.name} → inherited from "${baseName}..."`);
    }
  }

  log(`  Sibling inheritance: ${sibMatched} products`);

  // Final report
  log('');
  log('Final coverage:');
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

  // List any still-unresolved
  const { rows: finalMissing } = await pool.query(`
    SELECT p.name, c.slug as category, array_agg(s.vendor_sku) as vendor_skus
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
    GROUP BY p.id, p.name, c.slug
    ORDER BY c.slug, p.name
  `, [VENDOR_ID]);

  if (finalMissing.length > 0) {
    log('');
    log(`Still unresolved (${finalMissing.length} products):`);
    for (const p of finalMissing) {
      log(`  [${p.category || 'none'}] ${p.name} — ${p.vendor_skus.join(', ')}`);
    }
  }

  log('');
  log('═'.repeat(60));
  log(`  Direct fetch:    ${matched} products`);
  log(`  Sibling inherit: ${sibMatched} products`);
  log(`  Images added:    ${totalImages}`);
  log(`  Total SKUs:      ${totalSkus}`);
  log(`  With images:     ${totalWithImages} (${(100 * totalWithImages / totalSkus).toFixed(1)}%)`);
  log(`  Still missing:   ${totalSkus - totalWithImages}`);
  log(`  Time:            ${Math.round((Date.now() - startTime) / 1000)}s`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
