/**
 * MSI Enhanced Image Probing
 *
 * Targets the ~1,785 MSI SKUs still missing images after the initial CDN probe.
 * Uses expanded URL patterns and better color/collection name parsing.
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const CDN = 'https://cdn.msisurfaces.com/images';
const CONCURRENCY = 20;
const VERBOSE = process.argv.includes('--verbose');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─── HTTP HEAD with follow-redirects ─────────────────────────────────────────

function headUrl(url, maxRedirects = 3) {
  return new Promise(resolve => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request(url, { method: 'HEAD', timeout: 8000 }, res => {
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

async function probeFirst(urls) {
  // Probe in batches, return first hit
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(u => headUrl(u)));
    const hit = results.find(r => r !== null);
    if (hit) return hit;
  }
  return null;
}

async function probeAll(urls) {
  // Probe all, return all hits
  const hits = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(u => headUrl(u)));
    results.forEach(r => { if (r) hits.push(r); });
  }
  return hits;
}

// ─── Slugify helper ──────────────────────────────────────────────────────────

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

// Extract just the color from product name, stripping collection prefix & size suffix
function extractColor(productName, collection) {
  let name = productName || '';
  // Remove collection prefix if present
  if (collection && name.toLowerCase().startsWith(collection.toLowerCase())) {
    name = name.slice(collection.length).trim();
  }
  // Strip size patterns
  name = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/g, '').trim();
  // Strip finish/format suffixes
  name = name.replace(/\s+(matte|polished|honed|glossy|satin|brushed|tumbled|textured|bullnose|pencil|chair\s*rail)\s*$/i, '').trim();
  // Strip "Classic", "Gauged" etc
  name = name.replace(/\s+(classic|premium|select|gauged)\s*$/i, '').trim();
  return name || productName;
}

// ─── URL Builders per Category ───────────────────────────────────────────────

function buildLvpUrls(collection, color, vendorSku) {
  const cSlug = slugify(collection);
  const colorSlug = slugify(color);
  const urls = [];

  // Standard LVP: /lvt/detail/{collection}-{color}-vinyl-flooring.jpg
  urls.push(`${CDN}/lvt/detail/${cSlug}-${colorSlug}-vinyl-flooring.jpg`);
  urls.push(`${CDN}/lvt/detail/${colorSlug}-${cSlug}-vinyl-flooring.jpg`);
  // Without "vinyl-flooring" suffix
  urls.push(`${CDN}/lvt/detail/${cSlug}-${colorSlug}.jpg`);
  urls.push(`${CDN}/lvt/detail/${colorSlug}-${cSlug}.jpg`);
  // XL/XXL variants
  urls.push(`${CDN}/lvt/detail/xl-${cSlug}-${colorSlug}-vinyl-flooring.jpg`);
  urls.push(`${CDN}/lvt/detail/xxl-${cSlug}-${colorSlug}-vinyl-flooring.jpg`);
  // Everlife branding
  urls.push(`${CDN}/lvt/detail/everlife-${cSlug}-${colorSlug}-vinyl-flooring.jpg`);
  // Plank path
  urls.push(`${CDN}/lvt/${colorSlug}-${cSlug}-vinyl-flooring.jpg`);
  // Thumbnails
  urls.push(`${CDN}/lvt/thumbnails/${cSlug}-${colorSlug}-vinyl-flooring.jpg`);
  urls.push(`${CDN}/lvt/thumbnails/${colorSlug}-${cSlug}-vinyl-flooring.jpg`);
  // New pattern with hyphenated collection-color
  urls.push(`${CDN}/lvt/detail/${cSlug}-${colorSlug}-luxury-vinyl-plank-flooring.jpg`);

  return urls;
}

function buildPorcelainUrls(collection, color, vendorSku) {
  const cSlug = slugify(collection);
  const colorSlug = slugify(color);
  const urls = [];

  // Pattern: {color}-{collection}-porcelain.jpg
  urls.push(`${CDN}/porcelainceramic/${colorSlug}-${cSlug}-porcelain.jpg`);
  urls.push(`${CDN}/porcelainceramic/${cSlug}-${colorSlug}-porcelain.jpg`);
  // Without "-porcelain" suffix
  urls.push(`${CDN}/porcelainceramic/${colorSlug}-${cSlug}.jpg`);
  // Ceramic variant
  urls.push(`${CDN}/porcelainceramic/${colorSlug}-${cSlug}-ceramic.jpg`);
  // Thumbnails
  urls.push(`${CDN}/porcelainceramic/thumbnails/${colorSlug}-${cSlug}-porcelain.jpg`);
  urls.push(`${CDN}/porcelainceramic/thumbnails/${cSlug}-${colorSlug}-porcelain.jpg`);
  // With tile suffix
  urls.push(`${CDN}/porcelainceramic/${colorSlug}-${cSlug}-porcelain-tile.jpg`);
  // Full combo slug
  const combo = slugify(color + ' ' + collection);
  urls.push(`${CDN}/porcelainceramic/${combo}-porcelain.jpg`);
  urls.push(`${CDN}/porcelainceramic/${combo}.jpg`);

  return urls;
}

function buildMosaicUrls(collection, color, productName) {
  const cSlug = slugify(collection);
  const colorSlug = slugify(color);
  const nameSlug = slugify(productName);
  const urls = [];

  // /mosaics/{name}.jpg
  urls.push(`${CDN}/mosaics/${nameSlug}.jpg`);
  urls.push(`${CDN}/mosaics/${colorSlug}-${cSlug}.jpg`);
  urls.push(`${CDN}/mosaics/${cSlug}-${colorSlug}.jpg`);
  // Thumbnails
  urls.push(`${CDN}/mosaics/thumbnails/${nameSlug}.jpg`);
  urls.push(`${CDN}/mosaics/thumbnails/${colorSlug}-${cSlug}.jpg`);
  // Backsplash/glass variants
  urls.push(`${CDN}/backsplash/thumbnails/${nameSlug}.jpg`);
  urls.push(`${CDN}/backsplash/${nameSlug}.jpg`);
  // Wall panel path
  urls.push(`${CDN}/wallpanels/${nameSlug}.jpg`);
  urls.push(`${CDN}/wallpanels/thumbnails/${nameSlug}.jpg`);
  // With suffix
  urls.push(`${CDN}/mosaics/${nameSlug}-mosaic.jpg`);

  return urls;
}

function buildStackedStoneUrls(collection, color, productName, vendorSku) {
  const nameSlug = slugify(productName);
  const colorSlug = slugify(color);
  const cSlug = slugify(collection);
  const urls = [];

  // Stacked stone patterns from MSI CDN
  urls.push(`${CDN}/hardscaping/thumbnails/${nameSlug}.jpg`);
  urls.push(`${CDN}/hardscaping/${nameSlug}.jpg`);
  urls.push(`${CDN}/stackedstone/${nameSlug}.jpg`);
  urls.push(`${CDN}/stackedstone/thumbnails/${nameSlug}.jpg`);
  // {color}-stacked-stone.jpg
  urls.push(`${CDN}/stackedstone/${colorSlug}-stacked-stone.jpg`);
  urls.push(`${CDN}/stackedstone/${cSlug}-${colorSlug}-stacked-stone.jpg`);
  // Ledger panels
  urls.push(`${CDN}/hardscaping/thumbnails/${colorSlug}-ledger-panel.jpg`);
  urls.push(`${CDN}/hardscaping/${colorSlug}-ledger-panel.jpg`);
  // Strip collection from name for short slug
  const shortSlug = slugify(color.replace(/\s*(ledgestone|ledger|panel|corner|sq\s*rec|splitface|stacked|mosaic|flats?)\s*/gi, '').trim());
  urls.push(`${CDN}/stackedstone/${shortSlug}-stacked-stone.jpg`);
  urls.push(`${CDN}/stackedstone/thumbnails/${shortSlug}-stacked-stone.jpg`);
  urls.push(`${CDN}/hardscaping/${shortSlug}-stacked-stone.jpg`);
  urls.push(`${CDN}/hardscaping/thumbnails/${shortSlug}-stacked-stone.jpg`);

  // rockmount paths
  urls.push(`${CDN}/hardscaping/thumbnails/${shortSlug}-rockmount-stacked-stone.jpg`);
  urls.push(`${CDN}/hardscaping/${shortSlug}-rockmount-stacked-stone.jpg`);

  return urls;
}

function buildNaturalStoneUrls(collection, color, productName) {
  const nameSlug = slugify(productName);
  const colorSlug = slugify(color);
  const cSlug = slugify(collection);
  const urls = [];

  // Natural stone CDN patterns
  urls.push(`${CDN}/naturalstone/${nameSlug}.jpg`);
  urls.push(`${CDN}/naturalstone/thumbnails/${nameSlug}.jpg`);
  urls.push(`${CDN}/naturalstone/${colorSlug}-${cSlug}.jpg`);
  urls.push(`${CDN}/naturalstone/${cSlug}-${colorSlug}.jpg`);
  // Granite/marble/travertine specific paths
  for (const type of ['granite', 'marble', 'travertine', 'limestone', 'slate', 'quartzite', 'sandstone']) {
    urls.push(`${CDN}/${type}/${nameSlug}.jpg`);
    urls.push(`${CDN}/${type}/thumbnails/${nameSlug}.jpg`);
    urls.push(`${CDN}/${type}/${colorSlug}.jpg`);
    urls.push(`${CDN}/${type}/thumbnails/${colorSlug}.jpg`);
  }

  return urls;
}

function buildHardwoodUrls(collection, color, vendorSku) {
  const cSlug = slugify(collection);
  const colorSlug = slugify(color);
  const urls = [];

  urls.push(`${CDN}/hardwood/detail/${colorSlug}-${cSlug}-hardwood-flooring.jpg`);
  urls.push(`${CDN}/hardwood/detail/${cSlug}-${colorSlug}-hardwood-flooring.jpg`);
  urls.push(`${CDN}/hardwood/detail/${colorSlug}-${cSlug}.jpg`);
  urls.push(`${CDN}/hardwood/thumbnails/${colorSlug}-${cSlug}-hardwood-flooring.jpg`);
  urls.push(`${CDN}/hardwood/thumbnails/${cSlug}-${colorSlug}.jpg`);

  return urls;
}

// ─── Build all candidate URLs for a SKU ──────────────────────────────────────

function buildAllUrls(sku) {
  const { category, collection, product_name, color_clean, vendor_sku } = sku;
  const cat = (category || '').toLowerCase();
  const col = color_clean || product_name;

  if (/lvp|vinyl|spc|wpc|rigid/i.test(cat)) {
    return buildLvpUrls(collection, col, vendor_sku);
  }
  if (/hardwood|engineered/i.test(cat)) {
    return buildHardwoodUrls(collection, col, vendor_sku);
  }
  if (/mosaic|backsplash|glass|wall.*panel/i.test(cat)) {
    return buildMosaicUrls(collection, col, product_name);
  }
  if (/stacked.*stone|ledger/i.test(cat)) {
    return buildStackedStoneUrls(collection, col, product_name, vendor_sku);
  }
  if (/natural.*stone|marble|granite|travertine|quartzite|limestone|slate|sandstone/i.test(cat)) {
    return buildNaturalStoneUrls(collection, col, product_name);
  }
  if (/porcelain|ceramic|tile/i.test(cat)) {
    return buildPorcelainUrls(collection, col, vendor_sku);
  }
  if (/waterproof.*wood|woodhills/i.test(cat)) {
    return buildLvpUrls(collection, col, vendor_sku);
  }
  // Fallback: try LVP + porcelain patterns
  return [
    ...buildLvpUrls(collection, col, vendor_sku),
    ...buildPorcelainUrls(collection, col, vendor_sku),
    ...buildMosaicUrls(collection, col, product_name),
  ];
}

// ─── Save image to DB ────────────────────────────────────────────────────────

async function saveImage(productId, skuId, url, assetType, sortOrder) {
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log('MSI Enhanced Image Probing');
  log('═'.repeat(60));

  // Load all MSI SKUs missing images
  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.internal_sku,
           s.variant_name, s.variant_type, s.sell_by,
           p.name AS product_name, p.collection,
           c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [VENDOR_ID]);

  log(`  ${skus.length} SKUs missing images (excluding accessories)`);

  // Batch-load color attributes
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

  // Enrich each SKU with clean color
  for (const sku of skus) {
    const rawColor = colorMap.get(sku.sku_id) || sku.product_name;
    sku.color_clean = extractColor(rawColor, sku.collection);
  }

  // Group by category for reporting
  const byCat = {};
  for (const s of skus) {
    const cat = s.category || 'unknown';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(s);
  }
  for (const [cat, items] of Object.entries(byCat)) {
    log(`  ${cat}: ${items.length} missing`);
  }

  // Probe all
  let matched = 0, processed = 0;
  const total = skus.length;

  for (const sku of skus) {
    processed++;
    if (processed % 200 === 0) {
      log(`  Progress: ${processed}/${total} (${matched} matched, ${((Date.now() - startTime) / 1000).toFixed(0)}s)`);
    }

    const candidates = buildAllUrls(sku);
    if (candidates.length === 0) continue;

    // De-dup
    const unique = [...new Set(candidates)];
    if (VERBOSE && processed <= 3) {
      log(`    Sample ${sku.vendor_sku}: ${unique.length} URLs, color="${sku.color_clean}", coll="${sku.collection}", cat="${sku.category}"`);
      unique.slice(0, 4).forEach(u => log(`      ${u}`));
    }

    const hit = await probeFirst(unique);
    if (hit) {
      const isRoomScene = hit.includes('/roomscene');
      await saveImage(sku.product_id, sku.sku_id, hit, isRoomScene ? 'lifestyle' : 'primary', 0);
      matched++;

      // Try to find a second image (room scene if we got product, or vice versa)
      const remaining = unique.filter(u => u !== hit);
      if (remaining.length > 0) {
        const hit2 = await probeFirst(remaining);
        if (hit2) {
          const type2 = hit2.includes('/roomscene') ? 'lifestyle' : 'alternate';
          await saveImage(sku.product_id, sku.sku_id, hit2, type2, 1);
        }
      }
    }
  }

  // Sibling inheritance: if a product has any SKU with images, copy to siblings without
  log('');
  log('Sibling image inheritance...');
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
      SELECT ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma
      JOIN skus sib ON sib.id = ma.sku_id
      WHERE sib.product_id = $1 AND sib.id != $2
      ORDER BY ma.sort_order
      LIMIT 2
    `, [orphan.product_id, orphan.sku_id]);

    for (const img of sibImages) {
      await saveImage(orphan.product_id, orphan.sku_id, img.url, img.asset_type, img.sort_order);
    }
    if (sibImages.length > 0) inherited++;
  }

  log(`  Inherited images for ${inherited} SKUs from siblings`);

  // Final stats
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(DISTINCT s.id) AS total,
           COUNT(DISTINCT s.id) FILTER (WHERE EXISTS (
             SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id
           )) AS with_images
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [VENDOR_ID]);

  log('');
  log('═'.repeat(60));
  log(`  RESULTS`);
  log(`  New CDN matches:     ${matched}`);
  log(`  Sibling inherited:   ${inherited}`);
  log(`  Total SKUs:          ${stats.total}`);
  log(`  With images:         ${stats.with_images} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
  log(`  Still missing:       ${stats.total - stats.with_images}`);
  log(`  Time:                ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
