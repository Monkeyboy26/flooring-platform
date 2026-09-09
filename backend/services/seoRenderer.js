import { Router } from 'express';
import { fullProductName } from '../lib/productName.js';
import { facetSlug } from '../lib/facetSlug.js';
import { SERVICE_AREAS, SERVICE_CITIES, cityBySlug, citySlug } from '../lib/serviceAreas.js';
import { MATERIALS, REMODEL_ROOMS, PRIORITY_CITIES, materialBySlug, roomBySlug, isPriorityCity } from '../lib/localServices.js';

const SITE_URL = (process.env.SITE_URL || 'https://romaflooringdesigns.com').replace(/\/+$/, '');

// Crawler-facing product name — identical to the storefront PDP <h1>. fullProductName
// strips collection/size/token echoes and re-appends the category keyword, so the
// indexed <title> + JSON-LD name match what customers see (no keyword loss). Falls
// back to the raw stored name only if the composer returns empty.
function seoProductName(sku) {
  return (fullProductName(sku) || '').trim() || (sku.product_name || '');
}
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const CACHE_MAX_SIZE = 5000;

// ==================== In-Memory Cache ====================

const cache = new Map();
const inflight = new Map(); // promise coalescing for thundering herd

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  // Move to end for LRU ordering
  cache.delete(key);
  cache.set(key, entry);
  return entry.html;
}

function cacheSet(key, html) {
  // Evict oldest entries if at capacity
  if (cache.size >= CACHE_MAX_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { html, ts: Date.now() });
}

// Periodic sweep of expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts > CACHE_TTL) cache.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ==================== Path Parser ====================

function parsePath(reqPath, query) {
  const path = (reqPath || '/').replace(/\/+$/, '') || '/';

  // New: /shop/{categorySlug}/{productSlug} — SEO-friendly product URLs
  const productMatch = path.match(/^\/shop\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (productMatch && productMatch[1] !== 'sku') {
    return { type: 'product', categorySlug: productMatch[1], productSlug: productMatch[2] };
  }

  // /shop/sku/:id/:slug? — old UUID URLs → 301 redirect
  const skuMatch = path.match(/^\/shop\/sku\/([a-fA-F0-9-]+)/);
  if (skuMatch) return { type: 'sku-redirect', skuId: skuMatch[1] };

  // /shop/{slug} — single-segment programmatic facet landing page (Phase 2).
  // Distinct from the two-segment product URL above and /shop/sku/ legacy URLs.
  const landingMatch = path.match(/^\/shop\/([a-z0-9-]+)$/);
  if (landingMatch && landingMatch[1] !== 'sku') {
    return { type: 'landing', slug: landingMatch[1] };
  }

  // /collections/:slug
  const collectionMatch = path.match(/^\/collections\/([a-z0-9-]+)$/);
  if (collectionMatch) return { type: 'collection', slug: collectionMatch[1] };

  // /collections index
  if (path === '/collections') return { type: 'collections-index' };

  // /shop with ?category=X
  if (path === '/shop' && query && query.category) return { type: 'category', slug: query.category };

  // /shop browse
  if (path === '/shop') return { type: 'browse' };

  // static pages
  if (path === '/') return { type: 'static', page: 'home' };
  if (path === '/trade') return { type: 'static', page: 'trade' };
  if (path === '/installation') return { type: 'static', page: 'installation' };
  if (path === '/custom-accessories') return { type: 'static', page: 'custom-accessories' };
  if (path === '/custom-area-rugs') return { type: 'static', page: 'custom-area-rugs' };
  if (path === '/cabinets') return { type: 'static', page: 'cabinets' };
  if (path === '/privacy') return { type: 'static', page: 'privacy' };
  if (path === '/terms') return { type: 'static', page: 'terms' };

  // /flooring-installation/{city}/{material} — per-city material install page (nested)
  const matMatch = path.match(/^\/flooring-installation\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (matMatch) return { type: 'local_material', citySlug: matMatch[1], materialSlug: matMatch[2] };

  // /flooring-installation/{city} — per-city local landing page (Phase 3 local moat)
  const localMatch = path.match(/^\/flooring-installation\/([a-z0-9-]+)$/);
  if (localMatch) return { type: 'local', slug: localMatch[1] };

  // /remodeling/{city} hub + /remodeling/{city}/{room} — kitchen & bath remodel pages
  const remodelRoomMatch = path.match(/^\/remodeling\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (remodelRoomMatch) return { type: 'remodel', citySlug: remodelRoomMatch[1], roomSlug: remodelRoomMatch[2] };
  const remodelHubMatch = path.match(/^\/remodeling\/([a-z0-9-]+)$/);
  if (remodelHubMatch) return { type: 'remodel', citySlug: remodelHubMatch[1], roomSlug: null };

  // /guides + /guides/{slug} — pillar buying guides (Phase 4 authority content)
  if (path === '/guides') return { type: 'guides-index' };
  const guideMatch = path.match(/^\/guides\/([a-z0-9-]+)$/);
  if (guideMatch) return { type: 'guide', slug: guideMatch[1] };

  return { type: 'unknown' };
}

// ==================== Clean Description ====================

function cleanDescription(text, vendorName) {
  if (!text) return '';
  let cleaned = text;
  const boilerplatePatterns = [
    /\s*at\s+\w[\w\s]*(?:tile|surfaces|flooring)\s+we\s+have\s+.*/i,
    /\s*visit\s+(?:us\s+at\s+)?(?:www\.)?[\w.-]+\.\w+\s*.*/i,
    /\s*available\s+(?:exclusively\s+)?at\s+\w[\w\s]*(?:tile|surfaces|flooring)\s*.*/i,
    /\s*(?:shop|browse|explore)\s+(?:our\s+)?(?:full\s+)?(?:selection|collection|range)\s+at\s+.*/i,
    /\s*whether\s+you\s+are\s+building\s+your\s+dream\s+space\s*.*/i
  ];
  for (const pattern of boilerplatePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  if (vendorName) {
    const escapedVendor = vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const vendorPromo = new RegExp('\\s*(?:at|from|by)\\s+' + escapedVendor + '\\s+we\\s+.*', 'i');
    cleaned = cleaned.replace(vendorPromo, '');
  }
  return cleaned.trim();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeJsonLd(data) {
  return JSON.stringify(data).replace(/<\//g, '<\\/');
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ==================== Data Fetchers ====================

async function fetchSkuData(pool, skuId) {
  const result = await pool.query(`
    SELECT
      s.id as sku_id, s.variant_name, s.internal_sku, s.sell_by, s.variant_type,
      p.name as product_name, p.collection, p.format_label, p.description_long, p.description_short,
      COALESCE(br.name, v.name) as brand_name,
      (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) as brand_hidden,
      v.code as vendor_code, v.name as vendor_name, v.public_code as vendor_public_code,
      c.name as category_name, c.slug as category_slug,
      pr.retail_price,
      (SELECT ma.url FROM media_assets ma
       WHERE (ma.sku_id = s.id OR (ma.sku_id IS NULL AND ma.product_id = p.id))
         AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         ma.sort_order LIMIT 1) as primary_image,
      (SELECT ma.alt_text FROM media_assets ma
       WHERE (ma.sku_id = s.id OR (ma.sku_id IS NULL AND ma.product_id = p.id))
         AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         ma.sort_order LIMIT 1) as primary_image_alt,
      CASE
        WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
        WHEN inv.qty_on_hand > 10 THEN 'in_stock'
        WHEN inv.qty_on_hand > 0 THEN 'low_stock'
        ELSE 'out_of_stock'
      END as stock_status
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN brands br ON br.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
    WHERE s.id = $1 AND s.status = 'active' AND p.status = 'active'
      AND COALESCE(s.variant_type, '') != 'accessory' AND s.is_sample = false
  `, [skuId]);

  if (!result.rows.length) return null;
  const row = result.rows[0];

  // Fetch key attributes
  const attrResult = await pool.query(`
    SELECT a.name, a.slug, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE sa.sku_id = $1
    ORDER BY a.display_order, a.name
    LIMIT 10
  `, [skuId]);

  row.attributes = attrResult.rows;
  return row;
}

async function fetchProductBySlug(pool, categorySlug, productSlug) {
  const result = await pool.query(`
    SELECT
      s.id as sku_id, s.variant_name, s.internal_sku, s.sell_by, s.variant_type,
      p.name as product_name, p.collection, p.format_label, p.slug as product_slug, p.description_long, p.description_short,
      p.meta_title as seo_meta_title, p.meta_description as seo_meta_description, p.seo_h1, p.content_html,
      COALESCE(br.name, v.name) as brand_name,
      (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) as brand_hidden,
      v.code as vendor_code, v.name as vendor_name, v.public_code as vendor_public_code,
      c.name as category_name, c.slug as category_slug,
      pr.retail_price,
      (SELECT ma.url FROM media_assets ma
       WHERE (ma.sku_id = s.id OR (ma.sku_id IS NULL AND ma.product_id = p.id))
         AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         ma.sort_order LIMIT 1) as primary_image,
      (SELECT ma.alt_text FROM media_assets ma
       WHERE (ma.sku_id = s.id OR (ma.sku_id IS NULL AND ma.product_id = p.id))
         AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         ma.sort_order LIMIT 1) as primary_image_alt,
      CASE
        WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
        WHEN inv.qty_on_hand > 10 THEN 'in_stock'
        WHEN inv.qty_on_hand > 0 THEN 'low_stock'
        ELSE 'out_of_stock'
      END as stock_status
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.is_sample = false
      AND COALESCE(s.variant_type, '') NOT IN ('accessory','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN brands br ON br.id = p.brand_id
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
    WHERE c.slug = $1 AND p.slug = $2 AND p.status = 'active'
    ORDER BY s.created_at
    LIMIT 1
  `, [categorySlug, productSlug]);

  if (!result.rows.length) return null;
  const row = result.rows[0];

  const attrResult = await pool.query(`
    SELECT a.name, a.slug, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE sa.sku_id = $1
    ORDER BY a.display_order, a.name
    LIMIT 10
  `, [row.sku_id]);

  row.attributes = attrResult.rows;
  return row;
}

async function fetchSkuRedirectSlugs(pool, skuId) {
  const result = await pool.query(`
    SELECT p.slug as product_slug, c.slug as category_slug
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE s.id = $1
  `, [skuId]);
  if (!result.rows.length) return null;
  const { product_slug, category_slug } = result.rows[0];
  if (!product_slug || !category_slug) return null;
  return { productSlug: product_slug, categorySlug: category_slug };
}

async function fetchCollectionData(pool, slug) {
  // Find collection by slug-matching
  const collectionsResult = await pool.query(`
    SELECT DISTINCT p.collection as name
    FROM products p
    WHERE p.status = 'active' AND p.collection IS NOT NULL AND p.collection != ''
  `);

  const match = collectionsResult.rows.find(r =>
    slugify(r.name) === slug
  );
  if (!match) return null;

  const collectionName = match.name;

  const result = await pool.query(`
    SELECT * FROM (
      SELECT DISTINCT ON (p.id) p.id, p.name as product_name,
        p.slug as product_slug, c.slug as category_slug,
        pr.retail_price, s.sell_by, s.id as sku_id,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type != 'spec_pdf'
         ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
           CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 ELSE 2 END,
           ma.sort_order LIMIT 1) as image
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.is_sample = false
        AND COALESCE(s.variant_type, '') != 'accessory'
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.status = 'active' AND p.collection = $1
      ORDER BY p.id, pr.retail_price ASC NULLS LAST
    ) sub ORDER BY product_name
    LIMIT 12
  `, [collectionName]);

  const countResult = await pool.query(`
    SELECT COUNT(DISTINCT p.id)::int as product_count
    FROM products p
    WHERE p.status = 'active' AND p.collection = $1
  `, [collectionName]);

  // Representative image from first product
  const repImage = result.rows.length > 0 ? result.rows[0].image : null;

  return {
    name: collectionName,
    slug,
    product_count: countResult.rows[0].product_count,
    image: repImage,
    products: result.rows
  };
}

async function fetchCategoryData(pool, slug) {
  const result = await pool.query(`
    SELECT c.id, c.name, c.slug, c.description, c.image_url,
      c.meta_title as seo_meta_title, c.meta_description as seo_meta_description,
      c.intro_html, c.footer_html,
      (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id AND p.status = 'active') as product_count
    FROM categories c
    WHERE c.slug = $1 AND c.is_active = true
  `, [slug]);

  if (!result.rows.length) return null;
  const cat = result.rows[0];

  // Child categories
  const children = await pool.query(`
    SELECT c.name, c.slug, c.image_url,
      (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id AND p.status = 'active') as product_count
    FROM categories c
    WHERE c.parent_id = $1 AND c.is_active = true
    ORDER BY c.sort_order, c.name
  `, [cat.id]);

  cat.children = children.rows;

  // Internal-linking mesh: top indexable facet landing pages in this category.
  try {
    const facets = await pool.query(
      `SELECT slug, title FROM landing_pages
       WHERE type = 'facet' AND is_indexable = true AND filter_json->>'category' = $1
       ORDER BY product_count DESC LIMIT 12`,
      [cat.slug]
    );
    cat.facet_links = facets.rows;
  } catch { cat.facet_links = []; }
  return cat;
}

async function fetchCollectionsIndex(pool) {
  const result = await pool.query(`
    SELECT p.collection as name,
      COUNT(DISTINCT p.id)::int as product_count,
      (SELECT ma.url FROM media_assets ma
       JOIN products p2 ON p2.id = ma.product_id
       WHERE p2.collection = p.collection AND p2.status = 'active' AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as image
    FROM products p
    WHERE p.status = 'active' AND p.collection IS NOT NULL AND p.collection != ''
    GROUP BY p.collection
    ORDER BY p.collection
  `);
  return result.rows.map(r => ({ ...r, slug: slugify(r.name) }));
}

// ==================== HTML Builder ====================

function buildSeoHtml({ title, description, canonicalUrl, ogImage, ogType, robotsTag, jsonLd, bodyContent }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeCanonical = escapeHtml(canonicalUrl);
  const safeImage = escapeHtml(ogImage || '');
  const robots = escapeHtml(robotsTag || 'index, follow');

  const twitterCard = safeImage ? 'summary_large_image' : 'summary';
  const ogImageTag = safeImage ? `<meta property="og:image" content="${safeImage}">\n    <meta name="twitter:image" content="${safeImage}">` : '';
  const canonicalTag = canonicalUrl ? `<link rel="canonical" href="${safeCanonical}">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="${robots}">
  <link rel="icon" href="/favicon.ico?v=2" sizes="any">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png?v=2">
  <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png?v=2">
  <link rel="apple-touch-icon" href="/icons/icon-192.png?v=2">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  ${canonicalTag}
  <meta property="og:type" content="${escapeHtml(ogType || 'website')}">
  <meta property="og:site_name" content="Roma Flooring Designs">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  ${canonicalUrl ? `<meta property="og:url" content="${safeCanonical}">` : ''}
  ${ogImageTag}
  <meta name="twitter:card" content="${twitterCard}">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <script type="application/ld+json">${safeJsonLd(jsonLd)}</script>
  <style>
    body { font-family: 'Inter', Arial, sans-serif; margin: 0; padding: 0; color: #1c1917; line-height: 1.6; }
    header { background: #fafaf9; border-bottom: 1px solid #e7e5e4; padding: 1rem 2rem; }
    header nav a { color: #44403c; text-decoration: none; margin-right: 1.5rem; font-size: 0.875rem; }
    main { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
    footer { background: #1c1917; color: #a8a29e; padding: 2rem; text-align: center; font-size: 0.8125rem; margin-top: 3rem; }
    h1 { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 400; color: #1c1917; }
    .breadcrumb { font-size: 0.8125rem; color: #78716c; margin-bottom: 1rem; }
    .breadcrumb ol { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0; }
    .breadcrumb li::before { content: '\\203A'; margin: 0 0.4rem; }
    .breadcrumb li:first-child::before { content: ''; margin: 0; }
    .breadcrumb a { color: #78716c; text-decoration: underline; }
    .product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1.5rem; }
    .product-card { border: 1px solid #e7e5e4; padding: 1rem; }
    .product-card img { width: 100%; height: 200px; object-fit: cover; }
    .product-card h3 { font-size: 0.9375rem; margin: 0.5rem 0 0.25rem; }
    .product-card .price { color: #c8a97e; font-weight: 600; }
    .sku-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
    .sku-detail img { width: 100%; height: auto; }
    .sku-info .price { font-size: 1.5rem; color: #c8a97e; font-weight: 600; margin: 0.5rem 0; }
    .attr-list { list-style: none; padding: 0; }
    .attr-list li { padding: 0.25rem 0; border-bottom: 1px solid #f5f5f4; font-size: 0.875rem; }
    .collections-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    .collections-list a { display: block; padding: 1rem; border: 1px solid #e7e5e4; text-decoration: none; color: #1c1917; }
    .category-children { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
    .category-children a { padding: 0.5rem 1rem; border: 1px solid #e7e5e4; text-decoration: none; color: #44403c; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <nav>
      <a href="/">Roma Flooring Designs</a>
      <a href="/shop">Shop</a>
      <a href="/collections">Collections</a>
      <a href="/trade">Trade Program</a>
    </nav>
  </header>
  <main>${bodyContent}</main>
  <footer>
    <p>Roma Flooring Designs | 1440 S. State College Blvd #6M, Anaheim, CA 92806 | (714) 999-0009 | License #830966</p>
    <p>&copy; ${new Date().getFullYear()} Roma Flooring Designs. All rights reserved.</p>
  </footer>
</body>
</html>`;
}

// ==================== Per-Page Renderers ====================

function renderSkuPage(sku) {
  const desc = cleanDescription(sku.description_long || sku.description_short, sku.brand_name);
  // Hidden vendors/brands must never leak their real name into indexed metadata or structured data.
  // Use the public 3-digit code when hidden; null (omit) if there isn't one.
  const seoBrandName = sku.brand_hidden
    ? (sku.vendor_public_code != null ? String(sku.vendor_public_code) : null)
    : sku.brand_name;
  const priceNum = sku.retail_price ? Number(parseFloat(sku.retail_price).toFixed(2)) : null;
  const priceDisplay = priceNum !== null ? priceNum.toFixed(2) : null;
  const unit = sku.sell_by === 'unit' ? '/ea' : '/sqft';
  // Cleaned name matches the storefront PDP <h1> (de-echoed, category keyword retained).
  const cleanName = seoProductName(sku);
  const title = `${cleanName} | Roma Flooring Designs`;
  const metaDesc = desc ? desc.substring(0, 160) : `${cleanName}${seoBrandName ? ' from ' + seoBrandName : ''}. Premium flooring available at Roma Flooring Designs.`;
  // Canonical slug stays on the raw name — never change a live URL for a title tweak.
  const skuSlug = slugify(sku.product_name + (sku.variant_name ? '-' + sku.variant_name : ''));
  const canonicalUrl = `${SITE_URL}/shop/sku/${sku.sku_id}/${skuSlug}`;

  const availability = sku.stock_status === 'out_of_stock' ? 'https://schema.org/OutOfStock'
    : 'https://schema.org/InStock';

  const breadcrumbItems = [
    { name: 'Home', url: SITE_URL + '/' },
    { name: 'Shop', url: SITE_URL + '/shop' }
  ];
  if (sku.category_name) {
    breadcrumbItems.push({ name: sku.category_name, url: SITE_URL + '/shop?category=' + (sku.category_slug || '') });
  }
  breadcrumbItems.push({ name: cleanName, url: canonicalUrl });

  const PLACEHOLDER_IMAGE = SITE_URL + '/assets/product-placeholder.svg';
  const productImage = sku.primary_image || PLACEHOLDER_IMAGE;

  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: cleanName,
    image: productImage,
    sku: sku.internal_sku,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      availability,
      seller: { '@type': 'Organization', name: 'Roma Flooring Designs' },
      url: canonicalUrl
    }
  };
  // seoBrandName (computed above) respects hidden vendors — omit brand entirely if no public code.
  if (seoBrandName) productJsonLd.brand = { '@type': 'Brand', name: seoBrandName };
  if (desc) productJsonLd.description = desc;
  if (sku.category_name) productJsonLd.category = sku.category_name;
  if (priceNum) productJsonLd.offers.price = priceNum;

  const jsonLd = [
    productJsonLd,
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: item.name,
        item: item.url
      }))
    }
  ];

  // Breadcrumb HTML — semantic <nav><ol><li> structure
  const breadcrumbHtml = breadcrumbItems.map((item, i) =>
    i < breadcrumbItems.length - 1
      ? `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.name)}</a></li>`
      : `<li>${escapeHtml(item.name)}</li>`
  ).join('');

  // Attributes HTML
  const attrsHtml = sku.attributes && sku.attributes.length > 0
    ? `<ul class="attr-list">${sku.attributes.map(a => `<li><strong>${escapeHtml(a.name)}:</strong> ${escapeHtml(a.value)}</li>`).join('')}</ul>`
    : '';

  // Prefer stored alt text / H1 / long-form content (Phase 1 engine); else derive.
  const imgAlt = (sku.primary_image_alt && sku.primary_image_alt.trim())
    ? sku.primary_image_alt.trim()
    : cleanName;
  const h1Html = (sku.seo_h1 && sku.seo_h1.trim())
    ? escapeHtml(sku.seo_h1.trim())
    : escapeHtml(cleanName);
  const contentHtml = (sku.content_html && sku.content_html.trim())
    ? `<section class="sku-content">${sku.content_html}</section>`
    : '';
  // Internal-linking mesh: link this product into the indexable facet landing pages
  // it belongs to (populated for the slug path in renderPage; empty on the legacy path).
  const facetLinksHtml = (sku.facet_links && sku.facet_links.length)
    ? `<nav class="facet-links" aria-label="Related categories"><span>More like this:</span> ${sku.facet_links.map(f => `<a href="/shop/${escapeHtml(f.slug)}">${escapeHtml(f.title)}</a>`).join(' · ')}</nav>`
    : '';

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol>${breadcrumbHtml}</ol></nav>
    <article class="sku-detail">
      <div>${sku.primary_image ? `<img src="${escapeHtml(sku.primary_image)}" alt="${escapeHtml(imgAlt)}" width="600" height="600">` : ''}</div>
      <div class="sku-info">
        <h1>${h1Html}</h1>
        ${priceDisplay ? `<div class="price">$${priceDisplay}${unit}</div>` : ''}
        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
        ${sku.brand_hidden ? (sku.vendor_public_code ? `<p><strong>Brand:</strong> ${escapeHtml(String(sku.vendor_public_code))}</p>` : '') : `<p><strong>Brand:</strong> ${escapeHtml(sku.brand_name)}</p>`}
        <p><strong>SKU:</strong> ${escapeHtml(sku.internal_sku)}</p>
        ${sku.category_name ? `<p><strong>Category:</strong> <a href="/shop?category=${escapeHtml(sku.category_slug || '')}">${escapeHtml(sku.category_name)}</a></p>` : ''}
        ${sku.collection ? `<p><strong>Collection:</strong> <a href="/collections/${escapeHtml(slugify(sku.collection))}">${escapeHtml(sku.collection)}</a></p>` : ''}
        ${attrsHtml}
      </div>
    </article>
    ${facetLinksHtml}
    ${contentHtml}`;

  return { title, description: metaDesc, canonicalUrl, ogImage: sku.primary_image, ogType: 'product', jsonLd, bodyContent };
}

function renderProductPage(sku) {
  const desc = cleanDescription(sku.description_long || sku.description_short, sku.brand_name);
  // Hidden vendors/brands must never leak their real name into indexed metadata or structured data.
  // Use the public 3-digit code when hidden; null (omit) if there isn't one.
  const seoBrandName = sku.brand_hidden
    ? (sku.vendor_public_code != null ? String(sku.vendor_public_code) : null)
    : sku.brand_name;
  const priceNum = sku.retail_price ? Number(parseFloat(sku.retail_price).toFixed(2)) : null;
  const priceDisplay = priceNum !== null ? priceNum.toFixed(2) : null;
  const unit = sku.sell_by === 'unit' ? '/ea' : '/sqft';
  // Cleaned name identical to the storefront PDP <h1> — already includes the category
  // keyword (appended by fullProductName) and de-echoed collection/size, so no keyword
  // is lost vs. the old raw title.
  const cleanName = seoProductName(sku);
  // Prefer stored SEO fields (Phase 1 content engine) when present; else derive from cleanName.
  const title = (sku.seo_meta_title && sku.seo_meta_title.trim())
    ? sku.seo_meta_title.trim()
    : `${cleanName} | Roma Flooring Designs`.replace(/\s+/g, ' ');
  const metaDesc = (sku.seo_meta_description && sku.seo_meta_description.trim())
    ? sku.seo_meta_description.trim().substring(0, 320)
    : (desc ? desc.substring(0, 160) : `${cleanName}${seoBrandName ? ' from ' + seoBrandName : ''}. Premium ${(sku.category_name || 'flooring').toLowerCase()} available at Roma Flooring Designs.`);
  const canonicalUrl = `${SITE_URL}/shop/${sku.category_slug}/${sku.product_slug}`;

  const availability = sku.stock_status === 'out_of_stock' ? 'https://schema.org/OutOfStock'
    : 'https://schema.org/InStock';

  const breadcrumbItems = [
    { name: 'Home', url: SITE_URL + '/' },
    { name: 'Shop', url: SITE_URL + '/shop' }
  ];
  if (sku.category_name) {
    breadcrumbItems.push({ name: sku.category_name, url: SITE_URL + '/shop?category=' + (sku.category_slug || '') });
  }
  breadcrumbItems.push({ name: cleanName, url: canonicalUrl });

  const PLACEHOLDER_IMAGE = SITE_URL + '/assets/product-placeholder.svg';
  const productImage = sku.primary_image || PLACEHOLDER_IMAGE;

  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: cleanName,
    image: productImage,
    sku: sku.internal_sku,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      availability,
      seller: { '@type': 'Organization', name: 'Roma Flooring Designs' },
      url: canonicalUrl
    }
  };
  // seoBrandName (computed above) respects hidden vendors — omit brand entirely if no public code.
  if (seoBrandName) productJsonLd.brand = { '@type': 'Brand', name: seoBrandName };
  if (desc) productJsonLd.description = desc;
  if (sku.category_name) productJsonLd.category = sku.category_name;
  if (priceNum) productJsonLd.offers.price = priceNum;

  const jsonLd = [
    productJsonLd,
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: item.name,
        item: item.url
      }))
    }
  ];

  const breadcrumbHtml = breadcrumbItems.map((item, i) =>
    i < breadcrumbItems.length - 1
      ? `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.name)}</a></li>`
      : `<li>${escapeHtml(item.name)}</li>`
  ).join('');

  const attrsHtml = sku.attributes && sku.attributes.length > 0
    ? `<ul class="attr-list">${sku.attributes.map(a => `<li><strong>${escapeHtml(a.name)}:</strong> ${escapeHtml(a.value)}</li>`).join('')}</ul>`
    : '';

  // Prefer stored alt text / H1 / long-form content (Phase 1 engine); else derive.
  const imgAlt = (sku.primary_image_alt && sku.primary_image_alt.trim())
    ? sku.primary_image_alt.trim()
    : cleanName;
  const h1Html = (sku.seo_h1 && sku.seo_h1.trim())
    ? escapeHtml(sku.seo_h1.trim())
    : escapeHtml(cleanName);
  const contentHtml = (sku.content_html && sku.content_html.trim())
    ? `<section class="sku-content">${sku.content_html}</section>`
    : '';
  // Internal-linking mesh: link this product into the indexable facet landing pages
  // it belongs to (populated for the slug path in renderPage; empty on the legacy path).
  const facetLinksHtml = (sku.facet_links && sku.facet_links.length)
    ? `<nav class="facet-links" aria-label="Related categories"><span>More like this:</span> ${sku.facet_links.map(f => `<a href="/shop/${escapeHtml(f.slug)}">${escapeHtml(f.title)}</a>`).join(' · ')}</nav>`
    : '';

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol>${breadcrumbHtml}</ol></nav>
    <article class="sku-detail">
      <div>${sku.primary_image ? `<img src="${escapeHtml(sku.primary_image)}" alt="${escapeHtml(imgAlt)}" width="600" height="600">` : ''}</div>
      <div class="sku-info">
        <h1>${h1Html}</h1>
        ${priceDisplay ? `<div class="price">$${priceDisplay}${unit}</div>` : ''}
        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
        ${sku.brand_hidden ? (sku.vendor_public_code ? `<p><strong>Brand:</strong> ${escapeHtml(String(sku.vendor_public_code))}</p>` : '') : `<p><strong>Brand:</strong> ${escapeHtml(sku.brand_name)}</p>`}
        <p><strong>SKU:</strong> ${escapeHtml(sku.internal_sku)}</p>
        ${sku.category_name ? `<p><strong>Category:</strong> <a href="/shop?category=${escapeHtml(sku.category_slug || '')}">${escapeHtml(sku.category_name)}</a></p>` : ''}
        ${sku.collection ? `<p><strong>Collection:</strong> <a href="/collections/${escapeHtml(slugify(sku.collection))}">${escapeHtml(sku.collection)}</a></p>` : ''}
        ${attrsHtml}
      </div>
    </article>
    ${facetLinksHtml}
    ${contentHtml}`;

  return { title, description: metaDesc, canonicalUrl, ogImage: sku.primary_image, ogType: 'product', jsonLd, bodyContent };
}

function renderCollectionPage(data) {
  const title = `${data.name} Collection | Roma Flooring Designs`;
  const description = `Shop the ${data.name} collection — ${data.product_count} products available at Roma Flooring Designs.`;
  const canonicalUrl = `${SITE_URL}/collections/${data.slug}`;

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: data.name + ' Collection',
      description,
      url: canonicalUrl
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Collections', item: SITE_URL + '/collections' },
        { '@type': 'ListItem', position: 3, name: data.name, item: canonicalUrl }
      ]
    }
  ];

  const productsHtml = data.products.map(p => {
    const price = p.retail_price ? parseFloat(p.retail_price).toFixed(2) : null;
    const unit = p.sell_by === 'unit' ? '/ea' : '/sqft';
    const href = (p.product_slug && p.category_slug)
      ? `/shop/${p.category_slug}/${p.product_slug}`
      : `/shop/sku/${p.sku_id}/${slugify(p.product_name)}`;
    return `<div class="product-card">
      <a href="${href}">
        ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.product_name)}" width="240" height="200" loading="lazy">` : ''}
        <h3>${escapeHtml(p.product_name)}</h3>
        ${price ? `<div class="price">$${price}${unit}</div>` : ''}
      </a>
    </div>`;
  }).join('');

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/collections">Collections</a></li><li>${escapeHtml(data.name)}</li></ol></nav>
    <h1>${escapeHtml(data.name)} Collection</h1>
    <p>${data.product_count} products</p>
    <div class="product-grid">${productsHtml}</div>`;

  return { title, description, canonicalUrl, ogImage: data.image, jsonLd, bodyContent };
}

function renderCategoryPage(cat) {
  // Prefer stored SEO fields (Phase 1 engine) when present; else derive as before.
  const title = (cat.seo_meta_title && cat.seo_meta_title.trim())
    ? cat.seo_meta_title.trim()
    : `${cat.name} | Shop | Roma Flooring Designs`;
  const description = (cat.seo_meta_description && cat.seo_meta_description.trim())
    ? cat.seo_meta_description.trim()
    : (cat.description || `Browse ${cat.product_count} ${cat.name.toLowerCase()} products at Roma Flooring Designs.`);
  const canonicalUrl = `${SITE_URL}/shop?category=${cat.slug}`;

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: cat.name,
      description,
      url: canonicalUrl
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Shop', item: SITE_URL + '/shop' },
        { '@type': 'ListItem', position: 3, name: cat.name, item: canonicalUrl }
      ]
    }
  ];

  const childrenHtml = cat.children && cat.children.length > 0
    ? `<div class="category-children">${cat.children.map(ch =>
        `<a href="/shop?category=${escapeHtml(ch.slug)}">${escapeHtml(ch.name)} (${ch.product_count})</a>`
      ).join('')}</div>`
    : '';

  // intro_html / footer_html are authored by our own content engine (not user input) → raw.
  const introHtml = (cat.intro_html && cat.intro_html.trim())
    ? `<section class="category-intro">${cat.intro_html}</section>`
    : (cat.description ? `<p>${escapeHtml(cat.description)}</p>` : '');
  const footerHtml = (cat.footer_html && cat.footer_html.trim())
    ? `<section class="category-footer">${cat.footer_html}</section>`
    : '';

  // Internal-linking mesh: top facet landing pages in this category.
  const facetLinksHtml = (cat.facet_links && cat.facet_links.length)
    ? `<nav class="facet-links" aria-label="Shop by"><span>Popular filters:</span> ${cat.facet_links.map(f => `<a href="/shop/${escapeHtml(f.slug)}">${escapeHtml(f.title)}</a>`).join(' · ')}</nav>`
    : '';

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/shop">Shop</a></li><li>${escapeHtml(cat.name)}</li></ol></nav>
    <h1>${escapeHtml(cat.name)}</h1>
    ${introHtml}
    <p>${cat.product_count} products</p>
    ${facetLinksHtml}
    ${childrenHtml}
    ${footerHtml}`;

  // description may now be a full stored meta (up to 320) — cap OG/meta at a safe length.
  return { title, description: description.substring(0, 320), canonicalUrl, ogImage: cat.image_url, jsonLd, bodyContent };
}

function renderCollectionsIndex(collections) {
  const title = 'Collections | Roma Flooring Designs';
  const description = 'Explore our curated flooring collections from premium vendors.';
  const canonicalUrl = `${SITE_URL}/collections`;

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Collections',
      description,
      url: canonicalUrl
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Collections', item: canonicalUrl }
      ]
    }
  ];

  const listHtml = collections.map(c =>
    `<a href="/collections/${escapeHtml(c.slug)}">
      <strong>${escapeHtml(c.name)}</strong> — ${c.product_count} products
    </a>`
  ).join('');

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Collections</li></ol></nav>
    <h1>Collections</h1>
    <p>${description}</p>
    <div class="collections-list">${listHtml}</div>`;

  return { title, description, canonicalUrl, ogImage: null, jsonLd, bodyContent };
}

// ==================== Installation (local SEO) ====================
// Shared source of truth so the prerendered body and the JSON-LD stay in sync.
// SERVICE_AREAS now lives in ../lib/serviceAreas.js (shared with build-local-pages.mjs);
// keep frontend/storefront.jsx SERVICE_AREAS identical.

const INSTALL_TYPES = [
  ['Hardwood', 'Solid and engineered hardwood installation — nail-down, glue-down, or floating.'],
  ['Tile & Porcelain', 'Floor and wall tile, including large-format and mosaic, mortar-set by hand.'],
  ['Luxury Vinyl', 'Click-lock LVP and glue-down LVT for waterproof, durable performance.'],
  ['Natural Stone', 'Marble, travertine, slate, and quartzite set with expert care.'],
  ['Carpet', 'Stretch-in and direct-glue carpet for bedrooms, living areas, and commercial spaces.'],
  ['Laminate', 'Fast, affordable floating-floor laminate with seamless transitions.'],
];

const INSTALL_FAQ = [
  ['Do you install flooring in Anaheim and Orange County?', 'Yes. Roma Flooring Designs is based in Anaheim and installs flooring throughout all of Orange County, as well as neighboring Los Angeles County (Long Beach, Cerritos, Whittier, Downey and more) and Riverside County (Corona, Riverside, Eastvale and more).'],
  ['Are your installers licensed and insured?', 'Yes. We are a licensed California contractor (CSLB License #830966) and are fully bonded and insured for your protection.'],
  ['Do you offer free estimates?', 'Yes. We provide free, no-obligation estimates with clear, upfront pricing. Request a quote and our team follows up within one business day.'],
  ['How long does flooring installation take?', 'Most residential projects take one to three days depending on square footage, material, and subfloor prep. You get a firm timeline after the on-site measure.'],
  ['Do you remove and dispose of old flooring?', 'Yes. Demolition, subfloor prep, haul-away, and cleanup are all part of our full-service installation.'],
  ['Do I have to buy flooring from Roma to use your install crew?', 'We install materials purchased from our Anaheim showroom, and in many cases we can install flooring you already have. Contact us and we will walk you through the options.'],
];

// Real Google review data — loaded from the service_reviews table (populated only from
// genuine data via scripts/seo/ingest-service-reviews.mjs). Null until real reviews exist;
// we never fabricate ratings. Shape: { ratingValue: '4.9', reviewCount: 87, items: [...] }.
let INSTALL_REVIEWS = null;
let _reviewsLoadedAt = 0;
const REVIEWS_TTL = 60 * 60 * 1000; // 1 hour

// Refresh INSTALL_REVIEWS from the DB, at most once per hour. Called (awaited) at the top
// of the render handler so the synchronous installationBusinessNode() sees fresh data.
async function loadServiceReviews(pool) {
  if (Date.now() - _reviewsLoadedAt < REVIEWS_TTL) return;
  _reviewsLoadedAt = Date.now();
  try {
    const agg = await pool.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS avg, COUNT(*)::int AS cnt
         FROM service_reviews WHERE is_published = true`);
    const { avg, cnt } = agg.rows[0] || {};
    if (!cnt || Number(cnt) < 1) { INSTALL_REVIEWS = null; return; }
    const items = await pool.query(
      `SELECT author, rating, body FROM service_reviews
        WHERE is_published = true AND body IS NOT NULL AND body <> ''
        ORDER BY review_date DESC NULLS LAST, created_at DESC LIMIT 5`);
    INSTALL_REVIEWS = {
      ratingValue: String(avg), reviewCount: Number(cnt),
      items: items.rows.map(r => ({ author: r.author, rating: Number(r.rating), text: r.body })),
    };
  } catch { INSTALL_REVIEWS = null; }
}

const BUSINESS_ID = SITE_URL + '/#business';

function installationBusinessNode() {
  const node = {
    '@type': 'HomeAndConstructionBusiness',
    '@id': BUSINESS_ID,
    name: 'Roma Flooring Designs',
    url: SITE_URL + '/installation',
    logo: SITE_URL + '/icons/logo-512.png',
    telephone: '(714) 999-0009',
    priceRange: '$$',
    image: SITE_URL + '/uploads/og-default.jpg',
    address: { '@type': 'PostalAddress', streetAddress: '1440 S. State College Blvd #6M', addressLocality: 'Anaheim', addressRegion: 'CA', postalCode: '92806', addressCountry: 'US' },
    geo: { '@type': 'GeoCoordinates', latitude: 33.8271, longitude: -117.8827 },
    openingHoursSpecification: [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday'], opens: '09:00', closes: '17:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '10:00', closes: '15:00' }
    ],
    areaServed: [
      ...SERVICE_AREAS.flatMap(a => a.cities.map(c => ({ '@type': 'City', name: c }))),
      ...SERVICE_AREAS.map(a => ({ '@type': 'AdministrativeArea', name: a.county }))
    ],
    hasCredential: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'California Contractor License', identifier: '830966' }
  };
  if (INSTALL_REVIEWS && INSTALL_REVIEWS.reviewCount) {
    node.aggregateRating = { '@type': 'AggregateRating', ratingValue: String(INSTALL_REVIEWS.ratingValue), reviewCount: String(INSTALL_REVIEWS.reviewCount) };
    node.review = (INSTALL_REVIEWS.items || []).map(r => ({
      '@type': 'Review', author: { '@type': 'Person', name: r.author },
      reviewRating: { '@type': 'Rating', ratingValue: String(r.rating || INSTALL_REVIEWS.ratingValue) },
      reviewBody: r.text
    }));
  }
  return node;
}

function installationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      installationBusinessNode(),
      {
        '@type': 'Service',
        name: 'Flooring Installation',
        serviceType: 'Flooring installation',
        provider: { '@id': BUSINESS_ID },
        areaServed: SERVICE_AREAS.map(a => ({ '@type': 'AdministrativeArea', name: a.county })),
        hasOfferCatalog: {
          '@type': 'OfferCatalog',
          name: 'Flooring Installation Services',
          itemListElement: INSTALL_TYPES.map(([n, d]) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: n + ' Installation', description: d } }))
        }
      },
      { '@type': 'FAQPage', mainEntity: INSTALL_FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Flooring Installation', item: SITE_URL + '/installation' }
      ]}
    ]
  };
}

function renderInstallationPage() {
  const title = 'Flooring Installation in Anaheim & Orange County | Roma Flooring Designs';
  const description = 'Licensed, insured flooring installation in Anaheim & Orange County — hardwood, tile, luxury vinyl, stone, carpet & laminate. Free estimates. CA Lic #830966. Call (714) 999-0009.';
  const canonicalUrl = SITE_URL + '/installation';
  const typesHtml = INSTALL_TYPES.map(([n, d]) => `<li><strong>${escapeHtml(n)}:</strong> ${escapeHtml(d)}</li>`).join('');
  const faqHtml = INSTALL_FAQ.map(([q, a]) => `<h3>${escapeHtml(q)}</h3><p>${escapeHtml(a)}</p>`).join('');
  const areaHtml = SERVICE_AREAS.map(a => `<h3>${escapeHtml(a.county)}</h3><p>${a.cities.map(escapeHtml).join(', ')}</p>`).join('');
  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Flooring Installation</li></ol></nav>
    <h1>Flooring Installation in Anaheim &amp; Orange County</h1>
    <p>Roma Flooring Designs provides professional, licensed flooring installation across Anaheim and all of Orange County, plus neighboring Los Angeles and Riverside counties. Our installers bring decades of combined experience to hardwood, tile, luxury vinyl, natural stone, carpet, and laminate — with a clean, meticulous finish and a workmanship warranty on every project. Visit our showroom at 1440 S. State College Blvd #6M, Anaheim, CA 92806, or call (714) 999-0009. California Contractor License #830966.</p>
    <h2>What We Install</h2>
    <ul>${typesHtml}</ul>
    <h2>Our Southern California Service Area</h2>
    <p>We install across Orange County and neighboring Los Angeles and Riverside counties, including:</p>
    ${areaHtml}
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    <p><a href="/shop">Shop flooring</a> &middot; <a href="/cabinets">Custom cabinets</a></p>`;
  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd: installationJsonLd(), bodyContent };
}

// ==================== Custom Accessories (local SEO) ====================
// Keep ACC_* identical to frontend/storefront.jsx so prerender + SPA match.
const ACC_TILE = [
  ['Custom Bullnose', 'Finished, glazed edges fabricated from your own field tile and kiln-fired for a factory-grade finish — made from the same tile to minimize dye-lot variation.'],
  ['Cut-Downs', 'Your tile cut to custom sizes for liners, pencil trim, chair rails, and borders.'],
  ['Custom Mosaics', 'Mosaic sheets fabricated from the same tile you chose, for coordinated accents and niches.'],
  ['Tile Stair Treads', 'Porcelain and ceramic stair treads made from your tile with a finished, rounded nosing.'],
];
const ACC_WOOD = [
  ['Color-Matched Moldings', 'Reducers, T-moldings, thresholds, end caps, quarter round, and base shoe milled and finished to match your floor.'],
  ['Stair Parts', 'Stair nose, treads, risers, and landings made to match hardwood, laminate, or luxury vinyl plank.'],
  ['Custom Color Match', 'Trim stained and finished to closely match your floor color so transitions blend in.'],
];
const ACC_FAQ = [
  ['Can you make trim and accessories to match the floor I am buying?', 'Yes. We fabricate custom tile trim and color-matched wood moldings made to order for your specific tile or plank, so edges, stairs, and transitions are made to coordinate with your floor rather than relying on off-the-shelf pieces.'],
  ['Can you fabricate bullnose, cut-downs, and stair treads from my tile?', 'Yes. We take your field tile and fabricate custom bullnose, cut-down sizes, mosaics, and stair treads with a glazed, kiln-fired edge for a factory-grade finish — in any size, profile, and finish, including large-format and wood-look tile.'],
  ['Can you color-match wood moldings and stair parts to my floor?', 'Yes. We custom color-match reducers, T-moldings, thresholds, quarter round, stair nose, treads, risers, and landings to hardwood, laminate, and vinyl plank floors.'],
  ['How long do custom accessories take?', 'Because every piece is made to order, lead times vary by material and profile. We give you a firm timeline with your quote.'],
  ['Do I have to buy my flooring from Roma?', 'We fabricate matching accessories for materials purchased from our Anaheim showroom, and in many cases for flooring you already own. Contact us and we will review your project.'],
  ['Do you install the accessories or can I pick them up?', 'Both. Our Orange County crews can install your custom trim and stair parts, or you can pick them up at our Anaheim showroom.'],
];

function customAccessoriesJsonLd() {
  const business = {
    '@type': 'HomeAndConstructionBusiness',
    '@id': BUSINESS_ID,
    name: 'Roma Flooring Designs',
    url: SITE_URL + '/custom-accessories',
    logo: SITE_URL + '/icons/logo-512.png',
    telephone: '(714) 999-0009',
    priceRange: '$$',
    image: SITE_URL + '/uploads/og-default.jpg',
    address: { '@type': 'PostalAddress', streetAddress: '1440 S. State College Blvd #6M', addressLocality: 'Anaheim', addressRegion: 'CA', postalCode: '92806', addressCountry: 'US' },
    geo: { '@type': 'GeoCoordinates', latitude: 33.8271, longitude: -117.8827 },
    areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
    hasCredential: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'California Contractor License', identifier: '830966' }
  };
  const offers = [...ACC_TILE, ...ACC_WOOD].map(([n, d]) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: n, description: d } }));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      business,
      {
        '@type': 'Service', name: 'Custom Floor Trim & Tile Accessory Fabrication', serviceType: 'Custom flooring trim and tile accessory fabrication',
        provider: { '@id': BUSINESS_ID }, areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
        hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Custom Floor Accessories', itemListElement: offers }
      },
      { '@type': 'FAQPage', mainEntity: ACC_FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Custom Accessories', item: SITE_URL + '/custom-accessories' }
      ]}
    ]
  };
}

function renderCustomAccessoriesPage() {
  const title = 'Custom Tile Trim & Wood Floor Moldings | Roma Flooring Designs';
  const description = 'Custom floor accessories in Anaheim & Orange County — bullnose, cut-downs, mosaics & tile stair treads fabricated from your tile, plus color-matched wood moldings & stair parts. Made to order. Call (714) 999-0009.';
  const canonicalUrl = SITE_URL + '/custom-accessories';
  const tileHtml = ACC_TILE.map(([n, d]) => `<li><strong>${escapeHtml(n)}:</strong> ${escapeHtml(d)}</li>`).join('');
  const woodHtml = ACC_WOOD.map(([n, d]) => `<li><strong>${escapeHtml(n)}:</strong> ${escapeHtml(d)}</li>`).join('');
  const faqHtml = ACC_FAQ.map(([q, a]) => `<h3>${escapeHtml(q)}</h3><p>${escapeHtml(a)}</p>`).join('');
  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Custom Accessories</li></ol></nav>
    <h1>Custom Floor Trim &amp; Tile Accessories in Anaheim &amp; Orange County</h1>
    <p>Roma Flooring Designs fabricates custom trim and accessories made to match your floor — finished tile edges and color-matched wood moldings — so stairs, transitions, and borders look built-in, not bolted on. Every piece is made to order for your specific tile or plank. Visit our Anaheim showroom at 1440 S. State College Blvd #6M, Anaheim, CA 92806, or call (714) 999-0009.</p>
    <h2>Custom Tile Trim &amp; Edging</h2>
    <ul>${tileHtml}</ul>
    <h2>Custom Wood Trim &amp; Moldings</h2>
    <ul>${woodHtml}</ul>
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    <p><a href="/shop">Shop flooring</a> &middot; <a href="/installation">Flooring installation</a></p>`;
  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd: customAccessoriesJsonLd(), bodyContent };
}

// ==================== Custom Area Rugs (local SEO) ====================
// Keep RUG_* identical to frontend/storefront.jsx so prerender + SPA match.
const RUG_OPTIONS = [
  ['Custom-Size Rugs', 'Cut to any dimension your space needs — from entry mats to great-room rugs — so the fit is exact.'],
  ['Shapes & Runners', 'Rectangles, rounds, ovals, and custom outlines, plus hall and stair runners cut to length.'],
  ['Choose Your Carpet', 'Made from broadloom carpet — wool, nylon, and natural fibers in hundreds of colors and textures.'],
  ['Layer Over Any Floor', 'Define a room and protect hardwood, tile, and vinyl with a rug that coordinates with your floor.'],
];
const RUG_EDGES = [
  ['Serged Edge', 'Yarn wrapped tight to the pile for a clean, classic finished edge.'],
  ['Machine Binding', 'A durable fabric-tape border in a color to match or contrast your carpet.'],
  ['Cotton & Canvas Tape', 'A wide woven-tape border for a relaxed, casual look.'],
  ['Leather Binding', 'A premium leather or faux-leather border for a tailored, high-end edge.'],
];
const RUG_FAQ = [
  ['Can you make a custom-size area rug?', 'Yes. We cut and finish area rugs to any size and shape — rectangles, runners, rounds, and custom outlines — from broadloom carpet, so you get a rug that fits your space exactly.'],
  ['What carpet can I choose for my rug?', 'We make rugs from wool, nylon, and natural-fiber broadloom in a wide range of colors, patterns, and textures, including performance and indoor/outdoor options for high-traffic areas.'],
  ['What edge finishes do you offer?', 'Common finishes include a serged (yarn-wrapped) edge, machine binding, wide cotton or canvas tape, and leather or faux-leather binding — chosen to match or contrast your carpet.'],
  ['Can you make stair and hallway runners?', 'Yes. We cut and bind runners to length for stairs, halls, and entries so they coordinate with your rugs and flooring.'],
  ['Do I have to buy the carpet from Roma?', 'We bind rugs from carpet purchased at our Anaheim showroom, and in many cases from carpet you already have. Contact us and we will review your project.'],
  ['How long does a custom rug take?', 'Because every rug is made to order, lead times vary by size, material, and edge finish. We give you a firm timeline with your quote.'],
  ['Do you serve my area?', 'Our showroom is in Anaheim and we make custom area rugs for clients throughout Orange County.'],
];

function rugsJsonLd() {
  const business = {
    '@type': 'HomeAndConstructionBusiness', '@id': BUSINESS_ID, name: 'Roma Flooring Designs',
    url: SITE_URL + '/custom-area-rugs', logo: SITE_URL + '/icons/logo-512.png', telephone: '(714) 999-0009', priceRange: '$$', image: SITE_URL + '/uploads/og-default.jpg',
    address: { '@type': 'PostalAddress', streetAddress: '1440 S. State College Blvd #6M', addressLocality: 'Anaheim', addressRegion: 'CA', postalCode: '92806', addressCountry: 'US' },
    geo: { '@type': 'GeoCoordinates', latitude: 33.8271, longitude: -117.8827 },
    areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
    hasCredential: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'California Contractor License', identifier: '830966' }
  };
  const offers = [...RUG_OPTIONS, ...RUG_EDGES].map(([n, d]) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: n, description: d } }));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      business,
      {
        '@type': 'Service', name: 'Custom Area Rug Fabrication', serviceType: 'Custom area rug and runner fabrication and binding',
        provider: { '@id': BUSINESS_ID }, areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
        hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Custom Area Rugs & Runners', itemListElement: offers }
      },
      { '@type': 'FAQPage', mainEntity: RUG_FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Custom Area Rugs', item: SITE_URL + '/custom-area-rugs' }
      ]}
    ]
  };
}

function renderCustomAreaRugsPage() {
  const title = 'Custom Area Rugs & Runners in Anaheim & Orange County | Roma Flooring Designs';
  const description = 'Custom area rugs & runners in Anaheim & Orange County — cut and bound to any size and shape from wool, nylon & natural-fiber carpet, with serged, bound, or leather edges. Made to order. Call (714) 999-0009.';
  const canonicalUrl = SITE_URL + '/custom-area-rugs';
  const optHtml = RUG_OPTIONS.map(([n, d]) => `<li><strong>${escapeHtml(n)}:</strong> ${escapeHtml(d)}</li>`).join('');
  const edgeHtml = RUG_EDGES.map(([n, d]) => `<li><strong>${escapeHtml(n)}:</strong> ${escapeHtml(d)}</li>`).join('');
  const faqHtml = RUG_FAQ.map(([q, a]) => `<h3>${escapeHtml(q)}</h3><p>${escapeHtml(a)}</p>`).join('');
  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Custom Area Rugs</li></ol></nav>
    <h1>Custom Area Rugs &amp; Runners in Anaheim &amp; Orange County</h1>
    <p>Roma Flooring Designs cuts and binds custom area rugs and runners from broadloom carpet — made to any size, shape, and edge finish, and chosen to coordinate with your floor. Every rug is made to order at our Anaheim showroom at 1440 S. State College Blvd #6M, Anaheim, CA 92806, serving all of Orange County. Call (714) 999-0009.</p>
    <h2>Custom Rugs, Made Your Way</h2>
    <ul>${optHtml}</ul>
    <h2>Edge &amp; Binding Finishes</h2>
    <ul>${edgeHtml}</ul>
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    <p><a href="/shop">Shop flooring</a> &middot; <a href="/custom-accessories">Custom accessories</a> &middot; <a href="/installation">Flooring installation</a></p>`;
  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd: rugsJsonLd(), bodyContent };
}

// ==================== Cabinets (local SEO) ====================
const CAB_LINES = [
  ['Waypoint — Face-Frame Cabinetry', 'American-built', 'Classic, transitional & traditional kitchens', 'Painted maple and stained oak with a wood frame around the box for a classic, substantial look and time-tested strength.', ['Soft-close doors and drawers standard', 'Durable, dent-resistant painted and stained finishes', 'Six door styles from Shaker to arched and mullion']],
  ['Europa — Frameless Cabinetry', 'Italian-engineered', 'Modern, contemporary & minimal kitchens', 'Full-access, European-style boxes with slab and slim fronts, integrated handles, and clean modern lines.', ['Soft-close and push-to-open throughout', 'Full-access interiors with wider drawers', 'Panel-ready fronts for a seamless, built-in look']],
  ['Cabinets R Us — Face-Frame Cabinetry', 'Wholesale-direct', 'Transitional & modern kitchens, value-focused', 'Wholesale-direct value cabinetry — all-plywood boxes, solid-wood face frames, and soft-close dovetail drawers standard, kept in stock across shaker, flat-panel, high-gloss, and oak-tone door styles.', ['Soft-close dovetail drawers and doors standard', 'All-plywood boxes with solid-wood face frames', 'Shaker, flat-panel, high-gloss & oak-tone styles']],
];
const CAB_FAQ = [
  ['What is the difference between face-frame and frameless cabinets?', 'Face-frame cabinets have a wood frame around the front of the box for a classic, substantial look and traditional strength. Frameless cabinets mount doors and drawers directly to the box for full-access interiors, wider drawers, and clean, modern European lines.'],
  ['Do you design and install cabinets, or just sell them?', 'Both. We design your cabinetry in-house, help you choose the line, door style, and finish, and our own crew handles delivery and professional installation across Anaheim and Orange County.'],
  ['Do you offer a budget-friendly cabinet line?', 'Yes. Our Cabinets R Us line is a wholesale-direct, value-priced option with all-plywood boxes, solid-wood face frames, and soft-close dovetail drawers standard — quality construction at a lower price point, in shaker, flat-panel, high-gloss, and oak-tone styles.'],
  ['Can I see door styles and finishes in person?', 'Yes. Our Anaheim showroom has full display walls of all three cabinet lines, and you can take home free door samples in the finishes you are considering.'],
  ['Do you make kitchen and bathroom cabinets?', 'Yes — kitchens, bathroom vanities, laundry rooms, offices, and built-ins. All three cabinet lines are available for every room.'],
  ['How long do custom cabinets take?', 'Lead times vary by line and configuration. We give you a firm timeline with your quote once the design and selections are finalized.'],
  ['Do you serve my area?', 'Our showroom is in Anaheim and we design and install cabinetry throughout Orange County.'],
];

function cabinetsJsonLd() {
  const business = {
    '@type': 'HomeAndConstructionBusiness', '@id': BUSINESS_ID, name: 'Roma Flooring Designs',
    url: SITE_URL + '/cabinets', logo: SITE_URL + '/icons/logo-512.png', telephone: '(714) 999-0009', priceRange: '$$', image: SITE_URL + '/uploads/og-default.jpg',
    address: { '@type': 'PostalAddress', streetAddress: '1440 S. State College Blvd #6M', addressLocality: 'Anaheim', addressRegion: 'CA', postalCode: '92806', addressCountry: 'US' },
    geo: { '@type': 'GeoCoordinates', latitude: 33.8271, longitude: -117.8827 },
    areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
    hasCredential: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'California Contractor License', identifier: '830966' }
  };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      business,
      {
        '@type': 'Service', name: 'Custom Cabinet Design & Installation', serviceType: 'Kitchen and bath cabinet design and installation',
        provider: { '@id': BUSINESS_ID }, areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
        hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Cabinetry', itemListElement: CAB_LINES.map(l => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: l[0], description: l[3] } })) }
      },
      { '@type': 'FAQPage', mainEntity: CAB_FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Cabinets', item: SITE_URL + '/cabinets' }
      ]}
    ]
  };
}

function renderCabinetsPage() {
  const title = 'Custom Kitchen & Bath Cabinets in Anaheim & Orange County | Roma Flooring Designs';
  const description = 'Custom kitchen & bath cabinets in Anaheim & Orange County — Waypoint and Cabinets R Us face-frame lines plus Italian-engineered Europa frameless, designed in-house and installed by our crew. Visit our showroom. Call (714) 999-0009.';
  const canonicalUrl = SITE_URL + '/cabinets';
  const linesHtml = CAB_LINES.map(l => `<h3>${escapeHtml(l[0])} — ${escapeHtml(l[1])}</h3><p>${escapeHtml(l[3])}</p><ul>${l[4].map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul><p>Best for: ${escapeHtml(l[2])}.</p>`).join('');
  const faqHtml = CAB_FAQ.map(([q, a]) => `<h3>${escapeHtml(q)}</h3><p>${escapeHtml(a)}</p>`).join('');
  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Cabinets</li></ol></nav>
    <h1>Custom Kitchen &amp; Bath Cabinets in Anaheim &amp; Orange County</h1>
    <p>Roma Flooring Designs offers three cabinet lines, designed in-house and installed by our own crew: Waypoint American-built face-frame cabinetry, Cabinets R Us wholesale-direct face-frame cabinetry, and Europa Italian-engineered frameless cabinetry. See every door style and finish on full display walls at our Anaheim showroom at 1440 S. State College Blvd #6M, Anaheim, CA 92806, or call (714) 999-0009.</p>
    <h2>Our Three Cabinet Lines</h2>
    ${linesHtml}
    <h2>Face-Frame vs. Frameless</h2>
    <p>Face-frame cabinets have a wood frame around the front of the box for a classic, substantial look and traditional strength. Frameless cabinets mount doors and drawers directly to the box for full-access interiors, wider drawers, and clean, modern European lines.</p>
    <h2>Door Styles &amp; Finishes</h2>
    <p>Waypoint offers a dozen door styles (models 330–750) from Shaker to raised-panel and mullion, in a painted palette — Linen, Vanilla, Oat, Stone, Sage, Harbor, Navy, Slate, Cider, Amber, Black and more — plus stained maple, cherry, and hickory and Duraform laminate.</p>
    <p>Cabinets R Us is our wholesale-direct value line: all-plywood boxes with solid-wood face frames, soft-close dovetail drawers, and adjustable shelves. Door styles include Shaker (White, Gray, Espresso, Blue, Misty Grey, Olive Green, Black, and White Oak), Double Shaker, Double Slim oak tones, Classic glazed, and flat-panel high-gloss. CARB2 compliant and an NKBA member.</p>
    <p>Europa offers 75+ frameless door styles across painted, wood and Eurotek veneer, matte and high-gloss thermofoil, melamine, UltraLux, metal, and glass — thousands of finish combinations. Representative selections are on display at our Anaheim showroom; request door samples to confirm exact colors and the full current range.</p>
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    <p><a href="/installation">Flooring installation</a> &middot; <a href="/shop">Shop flooring</a></p>`;
  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd: cabinetsJsonLd(), bodyContent };
}

function renderStaticPage(page) {
  if (page === 'installation') return renderInstallationPage();
  if (page === 'custom-accessories') return renderCustomAccessoriesPage();
  if (page === 'custom-area-rugs') return renderCustomAreaRugsPage();
  if (page === 'cabinets') return renderCabinetsPage();
  const pages = {
    home: {
      title: 'Roma Flooring Designs | Premium Flooring & Tile in Anaheim, CA',
      description: 'Roma Flooring Designs offers premium flooring, tile, stone, and countertop products in Anaheim, CA.',
      path: '/',
      body: `<h1>Roma Flooring Designs</h1><p>Premium flooring, tile, stone, and countertop products in Anaheim, California. Browse our selection of hardwood, laminate, vinyl, tile, and natural stone from top manufacturers.</p><p><a href="/shop">Shop All Products</a> | <a href="/collections">Browse Collections</a> | <a href="/trade">Trade Program</a></p>`
    },
    trade: {
      title: 'Trade Program | Roma Flooring Designs',
      description: 'Join the Roma Flooring Designs trade program for exclusive contractor and designer pricing, dedicated support, and streamlined bulk ordering in Anaheim, CA.',
      path: '/trade',
      body: `<h1>Trade Program</h1><p>Roma Flooring Designs offers a professional trade program with exclusive pricing, dedicated support, and streamlined ordering for contractors, designers, and architects.</p><p><a href="/trade">Learn More &amp; Apply</a></p>`
    },
    privacy: {
      title: 'Privacy Policy | Roma Flooring Designs',
      description: 'Read the Roma Flooring Designs privacy policy to learn how we collect, use, and protect your personal information when you shop or use our website.',
      path: '/privacy',
      body: `<h1>Privacy Policy</h1><p>Roma Flooring Designs is committed to protecting your privacy. Please review our privacy policy for details on how we collect, use, and protect your information.</p>`
    },
    terms: {
      title: 'Terms of Service | Roma Flooring Designs',
      description: 'Review the Roma Flooring Designs terms of service covering purchasing, returns, shipping, and website usage policies for our flooring and tile products.',
      path: '/terms',
      body: `<h1>Terms of Service</h1><p>Please review our terms of service for details on purchasing, returns, and use of our website.</p>`
    }
  };

  const p = pages[page] || pages.home;
  const canonicalUrl = SITE_URL + p.path;

  const jsonLd = page === 'home' ? [{
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Roma Flooring Designs',
    alternateName: 'Roma Flooring',
    url: SITE_URL,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: SITE_URL + '/shop?search={search_term_string}' },
      'query-input': 'required name=search_term_string'
    }
  }, {
    '@context': 'https://schema.org',
    '@type': 'HomeGoodsStore',
    name: 'Roma Flooring Designs',
    url: SITE_URL,
    logo: SITE_URL + '/icons/logo-512.png',
    image: SITE_URL + '/icons/logo-512.png',
    telephone: '(714) 999-0009',
    priceRange: '$$',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '1440 S. State College Blvd #6M',
      addressLocality: 'Anaheim',
      addressRegion: 'CA',
      postalCode: '92806',
      addressCountry: 'US'
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: 33.8271,
      longitude: -117.8827
    },
    openingHoursSpecification: [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday'], opens: '09:00', closes: '17:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '10:00', closes: '15:00' }
    ]
  }] : {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: p.title,
    url: canonicalUrl
  };

  return { title: p.title, description: p.description, canonicalUrl, ogImage: null, jsonLd, bodyContent: p.body };
}

function renderBrowsePage() {
  const title = 'Shop All | Roma Flooring Designs';
  const description = 'Browse premium flooring, tile, stone, and countertop products.';
  const canonicalUrl = `${SITE_URL}/shop`;

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Shop All Products',
      description,
      url: canonicalUrl
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Shop', item: canonicalUrl }
      ]
    }
  ];

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Shop</li></ol></nav>
    <h1>Shop All Products</h1>
    <p>Browse our full selection of premium flooring, tile, stone, and countertop products from top manufacturers.</p>
    <p><a href="/collections">Browse by Collection</a></p>`;

  return { title, description, canonicalUrl, ogImage: null, jsonLd, bodyContent };
}

function render404Page(message) {
  return {
    title: 'Not Found | Roma Flooring Designs',
    description: 'The requested page was not found.',
    canonicalUrl: null,
    ogImage: null,
    robotsTag: 'noindex, nofollow',
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Not Found' },
    bodyContent: `<h1>Page Not Found</h1><p>${escapeHtml(message || 'The requested page could not be found.')}</p><p><a href="/shop">Continue Shopping</a></p>`
  };
}

// ==================== Landing pages (Phase 2 facet system) ====================

// Internal-linking mesh: given a rendered product, find the indexable facet landing
// pages it belongs to. Facet slugs are deterministic (slugify(value)-categorySlug),
// so we compute candidates from the product's attribute values and keep the ones that
// exist and are indexable. Guarded so a missing landing_pages table (pre-migration) is a no-op.
async function fetchFacetLinksForProduct(pool, sku) {
  if (!sku || !sku.category_slug || !sku.attributes || !sku.attributes.length) return [];
  // facetSlug (not plain slugify) so SIZE facets match build-landing-pages' slugs
  // ("24x48-…", not "24-x-48-…") — otherwise size facet pages get zero inbound
  // product links and are orphaned. a.slug identifies the size attribute.
  const slugs = [...new Set(sku.attributes.map(a => `${facetSlug(a.slug, a.value)}-${sku.category_slug}`))].filter(Boolean);
  if (!slugs.length) return [];
  try {
    const r = await pool.query(
      `SELECT slug, title FROM landing_pages
       WHERE slug = ANY($1) AND is_indexable = true
       ORDER BY product_count DESC LIMIT 6`,
      [slugs]
    );
    return r.rows;
  } catch { return []; }
}

// Fetch a landing_pages row + its product grid. filter_json is the browse query
// this page represents ({category, attributes:{slug:value}}); we replay it against
// the catalog with the same category + attribute semantics as /api/storefront/skus.
async function fetchLandingBySlug(pool, slug) {
  const res = await pool.query(`
    SELECT id, type, slug, title, h1, meta_title, meta_description,
           intro_html, footer_html, filter_json, is_indexable, product_count
    FROM landing_pages WHERE slug = $1
  `, [slug]);
  if (!res.rows.length) return null;
  const lp = res.rows[0];
  const filter = lp.filter_json || {};
  const attrs = filter.attributes || {};

  const where = [`p.status = 'active'`];
  const params = [];
  let i = 1;
  if (filter.category) {
    params.push(filter.category);
    where.push(`(c.slug = $${i} OR c.parent_id IN (SELECT id FROM categories WHERE slug = $${i}))`);
    i++;
  }
  for (const [aslug, val] of Object.entries(attrs)) {
    params.push(aslug); const sp = i++;
    params.push(val); const vp = i++;
    where.push(`EXISTS (SELECT 1 FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE s2.product_id = p.id AND s2.status = 'active' AND a.slug = $${sp} AND sa.value = $${vp})`);
  }

  const prod = await pool.query(`
    SELECT p.id, COALESCE(p.display_name, p.name) AS name, p.slug AS product_slug,
           c.slug AS category_slug, c.name AS category_name,
           (SELECT ma.url FROM media_assets ma
            WHERE ma.product_id = p.id AND ma.asset_type <> 'spec_pdf'
            ORDER BY CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
              ma.sort_order LIMIT 1) AS primary_image
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.sort_priority DESC, p.name
    LIMIT 60
  `, params);
  lp.products = prod.rows;

  // Internal-linking mesh: sibling facet pages in the same category (other colors/sizes).
  if (filter.category) {
    try {
      const sib = await pool.query(
        `SELECT slug, title FROM landing_pages
         WHERE type = 'facet' AND is_indexable = true
           AND filter_json->>'category' = $1 AND slug <> $2
         ORDER BY product_count DESC LIMIT 12`,
        [filter.category, slug]
      );
      lp.sibling_links = sib.rows;
    } catch { lp.sibling_links = []; }
  }
  return lp;
}

function renderLandingPage(lp) {
  const products = lp.products || [];
  const count = lp.product_count || products.length;
  const title = (lp.meta_title && lp.meta_title.trim())
    ? lp.meta_title.trim()
    : `${lp.title} | Roma Flooring Designs`;
  const description = (lp.meta_description && lp.meta_description.trim())
    ? lp.meta_description.trim()
    : `Shop ${count} ${lp.title.toLowerCase()} options at Roma Flooring Designs — compare colors, sizes, finishes, and prices.`;
  const canonicalUrl = `${SITE_URL}/shop/${lp.slug}`;
  // The indexation guardrail: thin pages render but stay out of the index.
  const robotsTag = lp.is_indexable ? 'index, follow' : 'noindex, follow';
  const h1 = lp.h1 || lp.title;
  const ogImage = products.length ? products[0].primary_image : null;

  const breadcrumbItems = [
    { name: 'Home', url: SITE_URL + '/' },
    { name: 'Shop', url: SITE_URL + '/shop' },
    { name: lp.title, url: canonicalUrl }
  ];

  const productUrl = (p) => (p.category_slug && p.product_slug)
    ? `${SITE_URL}/shop/${p.category_slug}/${p.product_slug}` : `${SITE_URL}/shop`;

  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: lp.title, description, url: canonicalUrl },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })) }
  ];
  if (products.length) {
    jsonLd.push({ '@context': 'https://schema.org', '@type': 'ItemList',
      itemListElement: products.slice(0, 30).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: productUrl(p), name: p.name })) });
  }

  const introHtml = (lp.intro_html && lp.intro_html.trim()) ? `<section class="landing-intro">${lp.intro_html}</section>` : '';
  const footerHtml = (lp.footer_html && lp.footer_html.trim()) ? `<section class="landing-footer">${lp.footer_html}</section>` : '';

  const gridHtml = products.length
    ? `<ul class="landing-grid">${products.map(p => {
        const href = (p.category_slug && p.product_slug) ? `/shop/${escapeHtml(p.category_slug)}/${escapeHtml(p.product_slug)}` : '/shop';
        const img = p.primary_image ? `<img src="${escapeHtml(p.primary_image)}" alt="${escapeHtml(p.name)}" width="300" height="300" loading="lazy">` : '';
        return `<li><a href="${href}">${img}<span>${escapeHtml(p.name)}</span></a></li>`;
      }).join('')}</ul>`
    : '<p>No products currently available.</p>';

  const breadcrumbHtml = breadcrumbItems.map((it, i) =>
    i < breadcrumbItems.length - 1
      ? `<li><a href="${escapeHtml(it.url)}">${escapeHtml(it.name)}</a></li>`
      : `<li>${escapeHtml(it.name)}</li>`
  ).join('');

  // Internal-linking mesh: parent category + sibling facet pages.
  const catSlug = (lp.filter_json && lp.filter_json.category) || null;
  const relatedParts = [
    ...(catSlug ? [`<a href="/shop?category=${escapeHtml(catSlug)}">Shop all</a>`] : []),
    ...((lp.sibling_links || []).map(s => `<a href="/shop/${escapeHtml(s.slug)}">${escapeHtml(s.title)}</a>`)),
  ];
  const relatedHtml = relatedParts.length
    ? `<nav class="facet-links" aria-label="Related"><span>Related:</span> ${relatedParts.join(' · ')}</nav>`
    : '';

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol>${breadcrumbHtml}</ol></nav>
    <h1>${escapeHtml(h1)}</h1>
    ${introHtml}
    <p>${count} products</p>
    ${gridHtml}
    ${relatedHtml}
    ${footerHtml}`;

  return { title, description: description.substring(0, 320), canonicalUrl, ogImage, ogType: 'website', robotsTag, jsonLd, bodyContent };
}

// ==================== Local city pages (Phase 3 local moat) ====================
// One indexable page per service-area city at /flooring-installation/{city}. Geo is
// authoritative from SERVICE_CITIES; the optional landing_pages row (type='local',
// minted by build-local-pages.mjs) supplies stored AI meta/intro/footer, else we fall
// back to templated per-city copy so the page renders before content generation.
async function fetchLocalRow(pool, slug) {
  try {
    const res = await pool.query(
      `SELECT meta_title, meta_description, intro_html, footer_html
       FROM landing_pages WHERE type = 'local' AND slug = $1`, [slug]);
    return res.rows[0] || null;
  } catch { return null; }
}

function renderLocalPage(city, row) {
  row = row || {};
  const canonicalUrl = `${SITE_URL}/flooring-installation/${city.slug}`;
  const title = (row.meta_title && row.meta_title.trim())
    ? row.meta_title.trim()
    : `Flooring Installation in ${city.city}, CA | Roma Flooring Designs`;
  const description = (row.meta_description && row.meta_description.trim())
    ? row.meta_description.trim()
    : `Licensed, insured flooring installation in ${city.city}, CA — hardwood, tile, luxury vinyl, stone, carpet & laminate. Free estimates. CA Lic #830966. Call (714) 999-0009.`;
  const h1 = `Flooring Installation in ${city.city}, CA`;

  const cityFaq = [
    [`Do you install flooring in ${city.city}?`, `Yes. Roma Flooring Designs installs flooring throughout ${city.city} and the surrounding ${city.county} area — hardwood, tile, luxury vinyl, natural stone, carpet, and laminate. We are based in nearby Anaheim.`],
    ...INSTALL_FAQ.slice(1)
  ];

  const jsonLd = { '@context': 'https://schema.org', '@graph': [
    installationBusinessNode(),
    { '@type': 'Service', name: `Flooring Installation in ${city.city}`, serviceType: 'Flooring installation',
      provider: { '@id': BUSINESS_ID }, areaServed: { '@type': 'City', name: city.city },
      hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Flooring Installation Services',
        itemListElement: INSTALL_TYPES.map(([n, d]) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: n + ' Installation', description: d } })) } },
    { '@type': 'FAQPage', mainEntity: cityFaq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Flooring Installation', item: SITE_URL + '/installation' },
      { '@type': 'ListItem', position: 3, name: city.city, item: canonicalUrl } ] }
  ]};

  // Internal-link mesh: for priority cities, link DOWN to the per-material install pages
  // and OVER to the remodeling hub (authority flows hub → children).
  const hasChildren = isPriorityCity(city.slug);
  const typesHtml = hasChildren
    ? MATERIALS.map(m => `<li><strong><a href="/flooring-installation/${city.slug}/${m.slug}">${escapeHtml(m.name)} Installation in ${escapeHtml(city.city)}</a>:</strong> ${escapeHtml(m.blurb)}</li>`).join('')
    : INSTALL_TYPES.map(([n, d]) => `<li><strong>${escapeHtml(n)}:</strong> ${escapeHtml(d)}</li>`).join('');
  const remodelHtml = hasChildren
    ? `<h2>Kitchen &amp; Bathroom Remodeling in ${escapeHtml(city.city)}</h2><p>Beyond flooring, we handle full <a href="/remodeling/${city.slug}">kitchen and bathroom remodels in ${escapeHtml(city.city)}</a> — ${REMODEL_ROOMS.map(r => `<a href="/remodeling/${city.slug}/${r.slug}">${escapeHtml(r.short.toLowerCase())} remodeling</a>`).join(', ')}, with tile, countertops, and cabinetry by one licensed crew.</p>`
    : '';
  const faqHtml = cityFaq.map(([q, a]) => `<h3>${escapeHtml(q)}</h3><p>${escapeHtml(a)}</p>`).join('');
  // Internal-link mesh: other cities in the same county.
  const nearby = SERVICE_CITIES.filter(c => c.county === city.county && c.slug !== city.slug).slice(0, 10);
  const nearbyHtml = nearby.length ? `<p>We also install flooring across ${escapeHtml(city.county)}: ${nearby.map(c => `<a href="/flooring-installation/${c.slug}">${escapeHtml(c.city)}</a>`).join(' &middot; ')}</p>` : '';
  const introHtml = (row.intro_html && row.intro_html.trim())
    ? row.intro_html
    : `<p>Roma Flooring Designs provides professional, licensed flooring installation in ${escapeHtml(city.city)}, California and throughout ${escapeHtml(city.county)}. From our Anaheim showroom we bring decades of combined experience to hardwood, tile, luxury vinyl, natural stone, carpet, and laminate — with a clean, meticulous finish and a workmanship warranty on every ${escapeHtml(city.city)} project. Call (714) 999-0009 for a free, no-obligation estimate. California Contractor License #830966.</p>`;
  const footerHtml = (row.footer_html && row.footer_html.trim()) ? `<section class="local-footer">${row.footer_html}</section>` : '';

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/installation">Flooring Installation</a></li><li>${escapeHtml(city.city)}</li></ol></nav>
    <h1>${escapeHtml(h1)}</h1>
    <section class="local-intro">${introHtml}</section>
    <h2>What We Install in ${escapeHtml(city.city)}</h2>
    <ul>${typesHtml}</ul>
    ${remodelHtml}
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    ${footerHtml}
    <h2>Serving ${escapeHtml(city.city)} &amp; Nearby</h2>
    ${nearbyHtml}
    <p><a href="/installation">All flooring installation services</a> &middot; <a href="/shop">Shop flooring</a> &middot; <a href="/custom-accessories">Custom accessories</a></p>`;

  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd, bodyContent };
}

// ==================== Per-city material install pages ====================
// /flooring-installation/{city}/{material} — nested under the city hub. Geo + material are
// authoritative from SERVICE_CITIES/MATERIALS; the optional landing_pages row
// (type='local_material') supplies stored AI meta/intro/content/footer, else templated copy.
async function fetchServiceRow(pool, type, slug) {
  try {
    const res = await pool.query(
      `SELECT meta_title, meta_description, intro_html, content_html, footer_html, filter_json
         FROM landing_pages WHERE type = $1 AND slug = $2`, [type, slug]);
    return res.rows[0] || null;
  } catch { return null; }
}

function renderMaterialPage(city, material, row) {
  row = row || {};
  const fj = row.filter_json || {};
  const canonicalUrl = `${SITE_URL}/flooring-installation/${city.slug}/${material.slug}`;
  const title = (row.meta_title && row.meta_title.trim())
    ? row.meta_title.trim()
    : `${material.name} Installation in ${city.city}, CA | Roma Flooring Designs`;
  const description = (row.meta_description && row.meta_description.trim())
    ? row.meta_description.trim()
    : `Licensed ${material.short.toLowerCase()} flooring installation in ${city.city}, CA. Expert subfloor prep, clean finish, free estimates. CA Lic #830966. Call (714) 999-0009.`;
  const h1 = `${material.name} Installation in ${city.city}, CA`;

  const faq = Array.isArray(fj.faq) ? fj.faq.map(x => Array.isArray(x) ? { q: x[0], a: x[1] } : x).filter(x => x && x.q && x.a) : [];
  const faqList = faq.length ? faq : [
    { q: `Do you install ${material.short.toLowerCase()} flooring in ${city.city}?`, a: `Yes. Roma Flooring Designs installs ${material.name.toLowerCase()} throughout ${city.city} and ${city.county}, from our Anaheim showroom. We are licensed (CA #830966), bonded, and insured.` },
    { q: 'Do you offer free estimates?', a: 'Yes — free, no-obligation estimates with clear, upfront pricing. Request a quote and we follow up within one business day.' },
    { q: 'Do you remove and dispose of the old floor?', a: 'Yes. Demolition, subfloor prep, haul-away, and cleanup are part of our full-service installation.' },
  ];

  const jsonLd = { '@context': 'https://schema.org', '@graph': [
    installationBusinessNode(),
    { '@type': 'Service', name: `${material.name} Installation in ${city.city}`, serviceType: `${material.name} installation`,
      provider: { '@id': BUSINESS_ID }, areaServed: { '@type': 'City', name: city.city },
      description: material.blurb },
    { '@type': 'FAQPage', mainEntity: faqList.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Flooring Installation', item: SITE_URL + '/installation' },
      { '@type': 'ListItem', position: 3, name: city.city, item: `${SITE_URL}/flooring-installation/${city.slug}` },
      { '@type': 'ListItem', position: 4, name: `${material.short} Installation`, item: canonicalUrl } ] }
  ]};

  const introHtml = (row.intro_html && row.intro_html.trim())
    ? row.intro_html
    : `<p>Roma Flooring Designs installs ${escapeHtml(material.name.toLowerCase())} for homeowners across ${escapeHtml(city.city)}, ${escapeHtml(city.county)}. ${escapeHtml(material.blurb)} Every ${escapeHtml(city.city)} project starts with an on-site measure and a firm, upfront estimate — and carries our workmanship warranty. California Contractor License #830966.</p>`;
  const contentHtml = (row.content_html && row.content_html.trim()) ? row.content_html : '';
  const faqHtml = faqList.map(f => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`).join('');
  const footerHtml = (row.footer_html && row.footer_html.trim()) ? `<section class="local-footer">${row.footer_html}</section>` : '';

  // Mesh: sibling materials in this city, shop the material, back up to the city hub.
  const siblings = MATERIALS.filter(m => m.slug !== material.slug);
  const siblingHtml = `<p>Other flooring we install in ${escapeHtml(city.city)}: ${siblings.map(m => `<a href="/flooring-installation/${city.slug}/${m.slug}">${escapeHtml(m.short)}</a>`).join(' &middot; ')}</p>`;

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/installation">Flooring Installation</a></li><li><a href="/flooring-installation/${city.slug}">${escapeHtml(city.city)}</a></li><li>${escapeHtml(material.short)}</li></ol></nav>
    <h1>${escapeHtml(h1)}</h1>
    <section class="local-intro">${introHtml}</section>
    ${contentHtml}
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    ${footerHtml}
    <p><a href="/shop?category=${escapeHtml(material.shopCategory)}">Shop ${escapeHtml(material.name.toLowerCase())}</a> &middot; <a href="/flooring-installation/${city.slug}">All flooring installation in ${escapeHtml(city.city)}</a> &middot; <a href="/installation">Request a free estimate</a></p>
    <h2>More in ${escapeHtml(city.city)}</h2>
    ${siblingHtml}`;

  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd, bodyContent };
}

// ==================== Per-city remodeling pages ====================
// /remodeling/{city} hub + /remodeling/{city}/{room}. type='remodel'; hub row has
// filter_json.room = null, room rows have filter_json.room = {slug}.
function renderRemodelPage(city, room, row) {
  row = row || {};
  const fj = row.filter_json || {};
  const isHub = !room;
  const canonicalUrl = isHub ? `${SITE_URL}/remodeling/${city.slug}` : `${SITE_URL}/remodeling/${city.slug}/${room.slug}`;
  const label = isHub ? 'Kitchen & Bath Remodeling' : room.name;
  const title = (row.meta_title && row.meta_title.trim())
    ? row.meta_title.trim()
    : `${label} in ${city.city}, CA | Roma Flooring Designs`;
  const description = (row.meta_description && row.meta_description.trim())
    ? row.meta_description.trim()
    : (isHub
        ? `Kitchen & bathroom remodeling in ${city.city}, CA — flooring, tile, countertops & cabinetry by one licensed crew. Free estimates. CA Lic #830966.`
        : `${room.name} in ${city.city}, CA. ${room.blurb} Licensed, insured, free estimates. CA Lic #830966. Call (714) 999-0009.`);
  const h1 = `${label} in ${city.city}, CA`;

  const faq = Array.isArray(fj.faq) ? fj.faq.map(x => Array.isArray(x) ? { q: x[0], a: x[1] } : x).filter(x => x && x.q && x.a) : [];
  const faqList = faq.length ? faq : [
    { q: `Do you do ${isHub ? 'kitchen and bathroom remodels' : room.short.toLowerCase() + ' remodels'} in ${city.city}?`, a: `Yes. Roma Flooring Designs handles ${isHub ? 'kitchen and bathroom' : room.short.toLowerCase()} remodeling throughout ${city.city} and ${city.county} — flooring, tile, countertops, and cabinetry — from our Anaheim showroom. Licensed (CA #830966), bonded, and insured.` },
    { q: 'Do you offer free estimates and design help?', a: 'Yes. We provide free, no-obligation estimates and help you select materials in our showroom, then coordinate the full install with one licensed crew.' },
    { q: 'Do you supply the materials too?', a: 'Yes — as a flooring, tile, stone, and countertop retailer we can supply and install everything, which keeps timelines and accountability under one roof.' },
  ];

  const services = REMODEL_ROOMS;
  const jsonLd = { '@context': 'https://schema.org', '@graph': [
    installationBusinessNode(),
    { '@type': 'Service', name: `${label} in ${city.city}`, serviceType: isHub ? 'Remodeling' : `${room.name}`,
      provider: { '@id': BUSINESS_ID }, areaServed: { '@type': 'City', name: city.city },
      description: isHub ? 'Kitchen and bathroom remodeling: flooring, tile, countertops, and cabinetry.' : room.blurb,
      ...(isHub ? { hasOfferCatalog: { '@type': 'OfferCatalog', name: `Remodeling Services in ${city.city}`,
        itemListElement: services.map(r => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: r.name, description: r.blurb } })) } } : {}) },
    { '@type': 'FAQPage', mainEntity: faqList.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Remodeling', item: `${SITE_URL}/remodeling/${city.slug}` },
      ...(isHub ? [] : [{ '@type': 'ListItem', position: 3, name: room.name, item: canonicalUrl }]) ] }
  ]};

  const introHtml = (row.intro_html && row.intro_html.trim())
    ? row.intro_html
    : (isHub
        ? `<p>Roma Flooring Designs remodels kitchens and bathrooms across ${escapeHtml(city.city)}, ${escapeHtml(city.county)}. As a flooring, tile, stone, and countertop retailer with a licensed install crew, we supply and set every surface — floors, wall and shower tile, countertops, and cabinetry — from our Anaheim showroom. Free estimates and one point of accountability. CA Contractor License #830966.</p>`
        : `<p>Roma Flooring Designs handles ${escapeHtml(room.name.toLowerCase())} for homeowners in ${escapeHtml(city.city)}, ${escapeHtml(city.county)}. ${escapeHtml(room.blurb)} We supply and install every surface from our Anaheim showroom, with free estimates and a workmanship warranty. CA Contractor License #830966.</p>`);
  const contentHtml = (row.content_html && row.content_html.trim()) ? row.content_html : '';
  const faqHtml = faqList.map(f => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`).join('');
  const footerHtml = (row.footer_html && row.footer_html.trim()) ? `<section class="local-footer">${row.footer_html}</section>` : '';

  const relatedLinks = (isHub ? [] : (room.related || []))
    .map(r => `<a href="${r.href}">${escapeHtml(r.label)}</a>`).join(' &middot; ');
  const roomsHtml = isHub
    ? `<h2>Remodeling Services in ${escapeHtml(city.city)}</h2><ul>${REMODEL_ROOMS.map(r => `<li><strong><a href="/remodeling/${city.slug}/${r.slug}">${escapeHtml(r.name)} in ${escapeHtml(city.city)}</a>:</strong> ${escapeHtml(r.blurb)}</li>`).join('')}</ul>`
    : `<p>${relatedLinks ? 'Shop the materials: ' + relatedLinks + ' &middot; ' : ''}<a href="/remodeling/${city.slug}">All remodeling in ${escapeHtml(city.city)}</a></p>`;

  const breadcrumbHtml = isHub
    ? `<nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Remodeling in ${escapeHtml(city.city)}</li></ol></nav>`
    : `<nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/remodeling/${city.slug}">Remodeling in ${escapeHtml(city.city)}</a></li><li>${escapeHtml(room.short)}</li></ol></nav>`;

  const bodyContent = `
    ${breadcrumbHtml}
    <h1>${escapeHtml(h1)}</h1>
    <section class="local-intro">${introHtml}</section>
    ${contentHtml}
    ${roomsHtml}
    <h2>Frequently Asked Questions</h2>
    ${faqHtml}
    ${footerHtml}
    <p><a href="/flooring-installation/${city.slug}">Flooring installation in ${escapeHtml(city.city)}</a> &middot; <a href="/cabinets">Cabinets</a> &middot; <a href="/installation">Request a free estimate</a></p>`;

  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd, bodyContent };
}

// ==================== Pillar guides (Phase 4 authority content) ====================
// Curated /guides/{slug} rows (type='guide', minted by build-guides.mjs). renderGuidePage
// emits Article + FAQPage + BreadcrumbList JSON-LD and links into money pages (categories).
async function fetchGuideBySlug(pool, slug) {
  const res = await pool.query(
    `SELECT slug, title, h1, meta_title, meta_description, intro_html, content_html, footer_html, filter_json
     FROM landing_pages WHERE type = 'guide' AND slug = $1`, [slug]);
  if (!res.rows.length) return null;
  const g = res.rows[0];
  const related = (g.filter_json && g.filter_json.related) || [];
  if (related.length) {
    try {
      const cats = await pool.query(`SELECT slug, name FROM categories WHERE slug = ANY($1) AND is_active = true`, [related]);
      const byslug = Object.fromEntries(cats.rows.map(r => [r.slug, r.name]));
      g.related_cats = related.map(s => ({ slug: s, name: byslug[s] || s.replace(/-/g, ' ') })).filter(c => byslug[c.slug]);
    } catch { g.related_cats = []; }
  } else g.related_cats = [];
  return g;
}

function renderGuidePage(g) {
  const fj = g.filter_json || {};
  const canonicalUrl = `${SITE_URL}/guides/${g.slug}`;
  const title = (g.meta_title && g.meta_title.trim()) ? g.meta_title.trim() : `${g.title} | Roma Flooring Designs`;
  const description = (g.meta_description && g.meta_description.trim())
    ? g.meta_description.trim()
    : `${g.title} — expert flooring & tile buying advice from Roma Flooring Designs.`;
  const h1 = g.h1 || g.title;
  const faq = Array.isArray(fj.faq) ? fj.faq.map(x => Array.isArray(x) ? { q: x[0], a: x[1] } : x).filter(x => x && x.q && x.a) : [];

  const jsonLd = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Article', headline: g.title, description, mainEntityOfPage: canonicalUrl,
      author: { '@type': 'Organization', name: 'Roma Flooring Designs', url: SITE_URL + '/' },
      publisher: { '@type': 'Organization', name: 'Roma Flooring Designs', logo: { '@type': 'ImageObject', url: SITE_URL + '/icons/logo-512.png' } } },
    ...(faq.length ? [{ '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: SITE_URL + '/guides' },
      { '@type': 'ListItem', position: 3, name: g.title, item: canonicalUrl } ] }
  ]};

  const introHtml = (g.intro_html && g.intro_html.trim()) ? g.intro_html : `<p>${escapeHtml(g.title)} — a practical buying guide from Roma Flooring Designs.</p>`;
  const contentHtml = (g.content_html && g.content_html.trim()) ? g.content_html : '';
  const faqHtml = faq.length ? `<h2>Frequently Asked Questions</h2>${faq.map(f => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`).join('')}` : '';
  const relatedHtml = (g.related_cats && g.related_cats.length)
    ? `<h2>Shop Related</h2><p>${g.related_cats.map(c => `<a href="/shop?category=${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`).join(' &middot; ')}</p>`
    : '';
  const footerHtml = (g.footer_html && g.footer_html.trim()) ? `<section class="guide-footer">${g.footer_html}</section>` : '';
  const calcNote = fj.kind === 'calculator' ? `<p><em>Use the interactive estimator on this page, or <a href="/installation">request a free estimate</a> for exact pricing.</em></p>` : '';

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/guides">Guides</a></li><li>${escapeHtml(g.title)}</li></ol></nav>
    <article class="guide">
      <h1>${escapeHtml(h1)}</h1>
      <section class="guide-intro">${introHtml}</section>
      ${contentHtml}
      ${calcNote}
      ${faqHtml}
      ${relatedHtml}
      ${footerHtml}
      <p><a href="/guides">All guides</a> &middot; <a href="/shop">Shop flooring</a> &middot; <a href="/installation">Flooring installation</a></p>
    </article>`;
  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd, bodyContent };
}

async function fetchGuidesIndex(pool) {
  try {
    const res = await pool.query(
      `SELECT slug, title, meta_description FROM landing_pages
       WHERE type = 'guide' AND is_indexable = true ORDER BY title`);
    return res.rows;
  } catch { return []; }
}

function renderGuidesIndex(guides) {
  const canonicalUrl = SITE_URL + '/guides';
  const title = 'Flooring & Tile Buying Guides | Roma Flooring Designs';
  const description = 'Expert flooring and tile buying guides — how to choose porcelain tile, LVP vs laminate, hardwood finishes, waterproof flooring, cost estimates, and more.';
  const jsonLd = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', name: 'Flooring & Tile Buying Guides', description, url: canonicalUrl },
    { '@type': 'ItemList', itemListElement: guides.map((g, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE_URL}/guides/${g.slug}`, name: g.title })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: canonicalUrl } ] }
  ]};
  const listHtml = guides.length
    ? `<ul class="guides-index">${guides.map(g => `<li><a href="/guides/${escapeHtml(g.slug)}"><strong>${escapeHtml(g.title)}</strong></a>${g.meta_description ? `<span> — ${escapeHtml(g.meta_description)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p>Guides coming soon.</p>';
  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li>Guides</li></ol></nav>
    <h1>Flooring &amp; Tile Buying Guides</h1>
    <p>Practical, expert advice to help you choose the right flooring and tile for your project — from an Anaheim showroom with decades of experience.</p>
    ${listHtml}
    <p><a href="/shop">Shop flooring</a> &middot; <a href="/installation">Flooring installation</a></p>`;
  return { title, description, canonicalUrl, ogImage: SITE_URL + '/uploads/og-default.jpg', jsonLd, bodyContent };
}

// ==================== Router ====================

export default function createSeoRouter(pool) {
  const router = Router();

  // Render a page (used directly and via promise coalescing)
  async function renderPage(parsed, pool) {
    let pageData;
    let statusCode = 200;

    // Refresh genuine review data (cached 1h) so service/local pages emit aggregateRating
    // JSON-LD once real reviews are ingested.
    await loadServiceReviews(pool);

    switch (parsed.type) {
      case 'product': {
        const sku = await fetchProductBySlug(pool, parsed.categorySlug, parsed.productSlug);
        if (!sku) {
          pageData = render404Page('Product not found.');
          statusCode = 404;
        } else {
          sku.facet_links = await fetchFacetLinksForProduct(pool, sku);
          pageData = renderProductPage(sku);
        }
        break;
      }
      case 'sku-redirect': {
        // Old UUID URL → 301 redirect to new slug URL
        const slugs = await fetchSkuRedirectSlugs(pool, parsed.skuId);
        if (slugs) {
          const newUrl = `${SITE_URL}/shop/${slugs.categorySlug}/${slugs.productSlug}`;
          return {
            html: `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${escapeHtml(newUrl)}"><link rel="canonical" href="${escapeHtml(newUrl)}"></head><body><p>Redirecting to <a href="${escapeHtml(newUrl)}">${escapeHtml(newUrl)}</a></p></body></html>`,
            statusCode: 301,
            redirectUrl: newUrl
          };
        }
        // Fallback: render old-style SKU page if slug not found
        const sku = await fetchSkuData(pool, parsed.skuId);
        if (!sku) {
          pageData = render404Page('Product not found.');
          statusCode = 404;
        } else {
          pageData = renderSkuPage(sku);
        }
        break;
      }
      case 'collection': {
        const collection = await fetchCollectionData(pool, parsed.slug);
        if (!collection) {
          pageData = render404Page('Collection not found.');
          statusCode = 404;
        } else {
          pageData = renderCollectionPage(collection);
        }
        break;
      }
      case 'category': {
        const category = await fetchCategoryData(pool, parsed.slug);
        if (!category) {
          pageData = render404Page('Category not found.');
          statusCode = 404;
        } else {
          pageData = renderCategoryPage(category);
        }
        break;
      }
      case 'collections-index': {
        const collections = await fetchCollectionsIndex(pool);
        pageData = renderCollectionsIndex(collections);
        break;
      }
      case 'landing': {
        const landing = await fetchLandingBySlug(pool, parsed.slug);
        if (!landing) {
          pageData = render404Page('Page not found.');
          statusCode = 404;
        } else {
          pageData = renderLandingPage(landing);
        }
        break;
      }
      case 'local': {
        const city = cityBySlug(parsed.slug);
        if (!city) {
          pageData = render404Page('Page not found.');
          statusCode = 404;
        } else {
          const row = await fetchLocalRow(pool, parsed.slug);
          pageData = renderLocalPage(city, row);
        }
        break;
      }
      case 'local_material': {
        const city = cityBySlug(parsed.citySlug);
        const material = materialBySlug(parsed.materialSlug);
        // Only priority cities carry material children; others 404 (no thin pages).
        if (!city || !material || !isPriorityCity(city.slug)) {
          pageData = render404Page('Page not found.');
          statusCode = 404;
        } else {
          const row = await fetchServiceRow(pool, 'local_material', `${city.slug}-${material.slug}`);
          pageData = renderMaterialPage(city, material, row);
        }
        break;
      }
      case 'remodel': {
        const city = cityBySlug(parsed.citySlug);
        const room = parsed.roomSlug ? roomBySlug(parsed.roomSlug) : null;
        const roomOk = !parsed.roomSlug || room; // hub, or a valid room
        if (!city || !roomOk || !isPriorityCity(city.slug)) {
          pageData = render404Page('Page not found.');
          statusCode = 404;
        } else {
          const slug = room ? `remodeling-${city.slug}-${room.slug}` : `remodeling-${city.slug}`;
          const row = await fetchServiceRow(pool, 'remodel', slug);
          pageData = renderRemodelPage(city, room, row);
        }
        break;
      }
      case 'guide': {
        const guide = await fetchGuideBySlug(pool, parsed.slug);
        if (!guide) {
          pageData = render404Page('Guide not found.');
          statusCode = 404;
        } else {
          pageData = renderGuidePage(guide);
        }
        break;
      }
      case 'guides-index': {
        pageData = renderGuidesIndex(await fetchGuidesIndex(pool));
        break;
      }
      case 'browse': {
        pageData = renderBrowsePage();
        break;
      }
      case 'static': {
        pageData = renderStaticPage(parsed.page);
        break;
      }
      default: {
        pageData = render404Page('The requested page could not be found.');
        statusCode = 404;
      }
    }

    return { html: buildSeoHtml(pageData), statusCode };
  }

  router.get('/api/seo/render', async (req, res) => {
    const reqPath = req.query.path || '/';
    const parsed = parsePath(reqPath, req.query);

    const cacheKey = parsed.type === 'product' ? `product:${parsed.categorySlug}/${parsed.productSlug}`
      : parsed.type === 'sku-redirect' ? `sku-redirect:${parsed.skuId}`
      : parsed.type === 'collection' ? `collection:${parsed.slug}`
      : parsed.type === 'category' ? `category:${parsed.slug}`
      : parsed.type === 'collections-index' ? 'collections-index'
      : parsed.type === 'landing' ? `landing:${parsed.slug}`
      : parsed.type === 'local' ? `local:${parsed.slug}`
      : parsed.type === 'local_material' ? `localmat:${parsed.citySlug}/${parsed.materialSlug}`
      : parsed.type === 'remodel' ? `remodel:${parsed.citySlug}/${parsed.roomSlug || ''}`
      : parsed.type === 'guide' ? `guide:${parsed.slug}`
      : parsed.type === 'guides-index' ? 'guides-index'
      : parsed.type === 'browse' ? 'browse'
      : parsed.type === 'static' ? `static:${parsed.page}`
      : null;

    // Check cache
    const cached = cacheKey ? cacheGet(cacheKey) : null;
    if (cached) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      res.set('X-SEO-Cache', 'HIT');
      return res.send(cached);
    }

    try {
      let result;

      // Promise coalescing: if another request for the same key is already
      // in flight, piggyback on it instead of issuing duplicate DB queries
      if (cacheKey && inflight.has(cacheKey)) {
        result = await inflight.get(cacheKey);
      } else {
        const promise = renderPage(parsed, pool);
        if (cacheKey) inflight.set(cacheKey, promise);
        try {
          result = await promise;
        } finally {
          if (cacheKey) inflight.delete(cacheKey);
        }
      }

      const { html, statusCode, redirectUrl } = result;

      // Handle 301 redirect with Location header
      if (statusCode === 301 && redirectUrl) {
        res.set('Location', redirectUrl);
        res.set('Cache-Control', 'public, max-age=86400');
        res.status(301);
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }

      // Only cache successful responses
      if (statusCode === 200 && cacheKey) {
        cacheSet(cacheKey, html);
      }

      res.status(statusCode);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', statusCode === 200 ? 'public, max-age=3600, s-maxage=86400' : 'no-store');
      res.set('X-SEO-Cache', 'MISS');
      res.send(html);
    } catch (err) {
      console.error('SEO render error:', err);
      const errorHtml = buildSeoHtml(render404Page('An error occurred.'));
      res.status(500);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(errorHtml);
    }
  });

  return router;
}
