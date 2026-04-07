import { Router } from 'express';

const SITE_URL = (process.env.SITE_URL || 'https://romaflooringdesigns.com').replace(/\/+$/, '');
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
  if (path === '/privacy') return { type: 'static', page: 'privacy' };
  if (path === '/terms') return { type: 'static', page: 'terms' };

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
      p.name as product_name, p.collection, p.description_long, p.description_short,
      v.name as vendor_name,
      c.name as category_name, c.slug as category_slug,
      pr.retail_price,
      (SELECT ma.url FROM media_assets ma
       WHERE (ma.sku_id = s.id OR (ma.sku_id IS NULL AND ma.product_id = p.id))
         AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         ma.sort_order LIMIT 1) as primary_image,
      CASE
        WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
        WHEN inv.qty_on_hand > 10 THEN 'in_stock'
        WHEN inv.qty_on_hand > 0 THEN 'low_stock'
        ELSE 'out_of_stock'
      END as stock_status
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
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
    SELECT a.name, sa.value
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
      p.name as product_name, p.collection, p.slug as product_slug, p.description_long, p.description_short,
      v.name as vendor_name,
      c.name as category_name, c.slug as category_slug,
      pr.retail_price,
      (SELECT ma.url FROM media_assets ma
       WHERE (ma.sku_id = s.id OR (ma.sku_id IS NULL AND ma.product_id = p.id))
         AND ma.asset_type != 'spec_pdf'
       ORDER BY CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
         ma.sort_order LIMIT 1) as primary_image,
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
    SELECT a.name, sa.value
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
  const desc = cleanDescription(sku.description_long || sku.description_short, sku.vendor_name);
  const priceNum = sku.retail_price ? Number(parseFloat(sku.retail_price).toFixed(2)) : null;
  const priceDisplay = priceNum !== null ? priceNum.toFixed(2) : null;
  const unit = sku.sell_by === 'unit' ? '/ea' : '/sqft';
  const title = `${sku.product_name}${sku.variant_name ? ' - ' + sku.variant_name : ''} | Roma Flooring Designs`;
  const metaDesc = desc ? desc.substring(0, 160) : `${sku.product_name} from ${sku.vendor_name}. Premium flooring available at Roma Flooring Designs.`;
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
  breadcrumbItems.push({ name: sku.product_name + (sku.variant_name ? ' - ' + sku.variant_name : ''), url: canonicalUrl });

  const PLACEHOLDER_IMAGE = SITE_URL + '/assets/product-placeholder.svg';
  const productImage = sku.primary_image || PLACEHOLDER_IMAGE;

  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: sku.product_name + (sku.variant_name ? ' - ' + sku.variant_name : ''),
    image: productImage,
    sku: sku.internal_sku,
    brand: { '@type': 'Brand', name: sku.vendor_name },
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      availability,
      seller: { '@type': 'Organization', name: 'Roma Flooring Designs' },
      url: canonicalUrl
    }
  };
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

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol>${breadcrumbHtml}</ol></nav>
    <article class="sku-detail">
      <div>${sku.primary_image ? `<img src="${escapeHtml(sku.primary_image)}" alt="${escapeHtml(sku.product_name + (sku.variant_name ? ' - ' + sku.variant_name : ''))}" width="600" height="600">` : ''}</div>
      <div class="sku-info">
        <h1>${escapeHtml(sku.product_name)}${sku.variant_name ? ' <span style="color:#78716c">- ' + escapeHtml(sku.variant_name) + '</span>' : ''}</h1>
        ${priceDisplay ? `<div class="price">$${priceDisplay}${unit}</div>` : ''}
        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
        <p><strong>Brand:</strong> ${escapeHtml(sku.vendor_name)}</p>
        <p><strong>SKU:</strong> ${escapeHtml(sku.internal_sku)}</p>
        ${sku.category_name ? `<p><strong>Category:</strong> <a href="/shop?category=${escapeHtml(sku.category_slug || '')}">${escapeHtml(sku.category_name)}</a></p>` : ''}
        ${sku.collection ? `<p><strong>Collection:</strong> <a href="/collections/${escapeHtml(slugify(sku.collection))}">${escapeHtml(sku.collection)}</a></p>` : ''}
        ${attrsHtml}
      </div>
    </article>`;

  return { title, description: metaDesc, canonicalUrl, ogImage: sku.primary_image, ogType: 'product', jsonLd, bodyContent };
}

function renderProductPage(sku) {
  const desc = cleanDescription(sku.description_long || sku.description_short, sku.vendor_name);
  const priceNum = sku.retail_price ? Number(parseFloat(sku.retail_price).toFixed(2)) : null;
  const priceDisplay = priceNum !== null ? priceNum.toFixed(2) : null;
  const unit = sku.sell_by === 'unit' ? '/ea' : '/sqft';
  const title = `${sku.product_name}${sku.collection ? ' ' + sku.collection : ''} ${sku.category_name || ''} | Roma Flooring Designs`.replace(/\s+/g, ' ');
  const metaDesc = desc ? desc.substring(0, 160) : `${sku.product_name} from ${sku.vendor_name}. Premium ${(sku.category_name || 'flooring').toLowerCase()} available at Roma Flooring Designs.`;
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
  breadcrumbItems.push({ name: sku.product_name, url: canonicalUrl });

  const PLACEHOLDER_IMAGE = SITE_URL + '/assets/product-placeholder.svg';
  const productImage = sku.primary_image || PLACEHOLDER_IMAGE;

  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: sku.product_name + (sku.variant_name ? ' - ' + sku.variant_name : ''),
    image: productImage,
    sku: sku.internal_sku,
    brand: { '@type': 'Brand', name: sku.vendor_name },
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      availability,
      seller: { '@type': 'Organization', name: 'Roma Flooring Designs' },
      url: canonicalUrl
    }
  };
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

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol>${breadcrumbHtml}</ol></nav>
    <article class="sku-detail">
      <div>${sku.primary_image ? `<img src="${escapeHtml(sku.primary_image)}" alt="${escapeHtml(sku.product_name + (sku.variant_name ? ' - ' + sku.variant_name : ''))}" width="600" height="600">` : ''}</div>
      <div class="sku-info">
        <h1>${escapeHtml(sku.product_name)}${sku.variant_name ? ' <span style="color:#78716c">- ' + escapeHtml(sku.variant_name) + '</span>' : ''}</h1>
        ${priceDisplay ? `<div class="price">$${priceDisplay}${unit}</div>` : ''}
        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
        <p><strong>Brand:</strong> ${escapeHtml(sku.vendor_name)}</p>
        <p><strong>SKU:</strong> ${escapeHtml(sku.internal_sku)}</p>
        ${sku.category_name ? `<p><strong>Category:</strong> <a href="/shop?category=${escapeHtml(sku.category_slug || '')}">${escapeHtml(sku.category_name)}</a></p>` : ''}
        ${sku.collection ? `<p><strong>Collection:</strong> <a href="/collections/${escapeHtml(slugify(sku.collection))}">${escapeHtml(sku.collection)}</a></p>` : ''}
        ${attrsHtml}
      </div>
    </article>`;

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
  const title = `${cat.name} | Shop | Roma Flooring Designs`;
  const description = cat.description || `Browse ${cat.product_count} ${cat.name.toLowerCase()} products at Roma Flooring Designs.`;
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

  const bodyContent = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/shop">Shop</a></li><li>${escapeHtml(cat.name)}</li></ol></nav>
    <h1>${escapeHtml(cat.name)}</h1>
    ${cat.description ? `<p>${escapeHtml(cat.description)}</p>` : ''}
    <p>${cat.product_count} products</p>
    ${childrenHtml}`;

  return { title, description: description.substring(0, 160), canonicalUrl, ogImage: cat.image_url, jsonLd, bodyContent };
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

function renderStaticPage(page) {
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

  const jsonLd = page === 'home' ? {
    '@context': 'https://schema.org',
    '@type': 'HomeGoodsStore',
    name: 'Roma Flooring Designs',
    url: SITE_URL,
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
  } : {
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

// ==================== Router ====================

export default function createSeoRouter(pool) {
  const router = Router();

  // Render a page (used directly and via promise coalescing)
  async function renderPage(parsed, pool) {
    let pageData;
    let statusCode = 200;

    switch (parsed.type) {
      case 'product': {
        const sku = await fetchProductBySlug(pool, parsed.categorySlug, parsed.productSlug);
        if (!sku) {
          pageData = render404Page('Product not found.');
          statusCode = 404;
        } else {
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
