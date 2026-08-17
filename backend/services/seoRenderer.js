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
  if (path === '/installation') return { type: 'static', page: 'installation' };
  if (path === '/custom-accessories') return { type: 'static', page: 'custom-accessories' };
  if (path === '/custom-area-rugs') return { type: 'static', page: 'custom-area-rugs' };
  if (path === '/cabinets') return { type: 'static', page: 'cabinets' };
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
      COALESCE(br.name, v.name) as brand_name,
      (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) as brand_hidden,
      v.code as vendor_code,
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
      COALESCE(br.name, v.name) as brand_name,
      (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) as brand_hidden,
      v.code as vendor_code,
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
  const desc = cleanDescription(sku.description_long || sku.description_short, sku.brand_name);
  const priceNum = sku.retail_price ? Number(parseFloat(sku.retail_price).toFixed(2)) : null;
  const priceDisplay = priceNum !== null ? priceNum.toFixed(2) : null;
  const unit = sku.sell_by === 'unit' ? '/ea' : '/sqft';
  const title = `${sku.product_name}${sku.variant_name ? ' - ' + sku.variant_name : ''} | Roma Flooring Designs`;
  const metaDesc = desc ? desc.substring(0, 160) : `${sku.product_name} from ${sku.brand_name}. Premium flooring available at Roma Flooring Designs.`;
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
    brand: { '@type': 'Brand', name: sku.brand_name },
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
        ${sku.brand_hidden ? (sku.vendor_code ? `<p><strong>Brand:</strong> ${escapeHtml(String(sku.vendor_code))}</p>` : '') : `<p><strong>Brand:</strong> ${escapeHtml(sku.brand_name)}</p>`}
        <p><strong>SKU:</strong> ${escapeHtml(sku.internal_sku)}</p>
        ${sku.category_name ? `<p><strong>Category:</strong> <a href="/shop?category=${escapeHtml(sku.category_slug || '')}">${escapeHtml(sku.category_name)}</a></p>` : ''}
        ${sku.collection ? `<p><strong>Collection:</strong> <a href="/collections/${escapeHtml(slugify(sku.collection))}">${escapeHtml(sku.collection)}</a></p>` : ''}
        ${attrsHtml}
      </div>
    </article>`;

  return { title, description: metaDesc, canonicalUrl, ogImage: sku.primary_image, ogType: 'product', jsonLd, bodyContent };
}

function renderProductPage(sku) {
  const desc = cleanDescription(sku.description_long || sku.description_short, sku.brand_name);
  const priceNum = sku.retail_price ? Number(parseFloat(sku.retail_price).toFixed(2)) : null;
  const priceDisplay = priceNum !== null ? priceNum.toFixed(2) : null;
  const unit = sku.sell_by === 'unit' ? '/ea' : '/sqft';
  const title = `${sku.product_name}${sku.collection ? ' ' + sku.collection : ''} ${sku.category_name || ''} | Roma Flooring Designs`.replace(/\s+/g, ' ');
  const metaDesc = desc ? desc.substring(0, 160) : `${sku.product_name} from ${sku.brand_name}. Premium ${(sku.category_name || 'flooring').toLowerCase()} available at Roma Flooring Designs.`;
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
    brand: { '@type': 'Brand', name: sku.brand_name },
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
        ${sku.brand_hidden ? (sku.vendor_code ? `<p><strong>Brand:</strong> ${escapeHtml(String(sku.vendor_code))}</p>` : '') : `<p><strong>Brand:</strong> ${escapeHtml(sku.brand_name)}</p>`}
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

// ==================== Installation (local SEO) ====================
// Shared source of truth so the prerendered body and the JSON-LD stay in sync.
// Tri-county service area — keep identical to frontend/storefront.jsx SERVICE_AREAS.
const SERVICE_AREAS = [
  { county: 'Orange County', cities: ['Anaheim','Fullerton','Irvine','Orange','Tustin','Santa Ana','Yorba Linda','Placentia','Brea','Buena Park','Huntington Beach','Costa Mesa','Newport Beach','Mission Viejo','Lake Forest','Laguna Hills'] },
  { county: 'Los Angeles County', cities: ['Long Beach','Cerritos','Lakewood','La Mirada','Whittier','Norwalk','Downey','Diamond Bar','West Covina','Pomona'] },
  { county: 'Riverside County', cities: ['Corona','Riverside','Eastvale','Norco','Jurupa Valley','Moreno Valley'] },
];

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

// Real Google review data. Leave null until genuine data is supplied — never fabricate
// ratings. Shape: { ratingValue: '4.9', reviewCount: 87, items: [{ author, rating, text }] }
const INSTALL_REVIEWS = null;

const BUSINESS_ID = SITE_URL + '/#business';

function installationBusinessNode() {
  const node = {
    '@type': 'HomeAndConstructionBusiness',
    '@id': BUSINESS_ID,
    name: 'Roma Flooring Designs',
    url: SITE_URL + '/installation',
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
    url: SITE_URL + '/custom-area-rugs', telephone: '(714) 999-0009', priceRange: '$$', image: SITE_URL + '/uploads/og-default.jpg',
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
    url: SITE_URL + '/cabinets', telephone: '(714) 999-0009', priceRange: '$$', image: SITE_URL + '/uploads/og-default.jpg',
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
