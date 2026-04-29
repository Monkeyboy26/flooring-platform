const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });
const map = require('../data/daltile-product-map.json');

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

function upgradeRendition(url) {
  if (!url) return null;
  let clean = url.split('?')[0];
  // Remove Scene7 preset suffix like :SwatchThumbnail or $TRIMTHUMBNAIL$
  clean = clean.replace(/[:$][A-Za-z$]+$/, '');
  
  // Skip non-DAM URLs (Scene7)
  if (!clean.includes('digitalassets.daltile.com')) return clean;
  
  // Replace any existing rendition with 1280
  if (clean.includes('/jcr:content/renditions/')) {
    return clean.replace(/\/jcr:content\/renditions\/[^/]+$/, '/jcr:content/renditions/cq5dam.web.1280.1280.jpeg');
  }
  
  // Append rendition path if none exists
  return clean + '/jcr:content/renditions/cq5dam.web.1280.1280.jpeg';
}

async function main() {
  // Get imageless SKUs
  const res = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.sku_id = s.id AND m.asset_type = 'primary')
      AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.product_id = s.product_id AND m.sku_id IS NULL AND m.asset_type = 'primary')
    ORDER BY p.collection, p.name
  `);
  
  console.log(`Imageless SKUs: ${res.rows.length}`);
  
  // Build vendor_sku → product map lookup
  const skuToMap = new Map();
  for (const [sn, series] of Object.entries(map.series)) {
    for (const [cn, product] of Object.entries(series.products || {})) {
      for (const sku of product.skus || []) {
        if (sku.coveoSku && sku.productImageUrl) {
          skuToMap.set(sku.coveoSku, { imageUrl: sku.productImageUrl, series: sn, color: cn });
        }
      }
    }
    for (const [cn, acc] of Object.entries(series.accessories || {})) {
      for (const sku of acc.skus || []) {
        if (sku.coveoSku && sku.productImageUrl) {
          skuToMap.set(sku.coveoSku, { imageUrl: sku.productImageUrl, series: sn, color: cn });
        }
      }
    }
  }
  
  // Also build color code → first available image for fallback
  const colorCodeToImage = new Map();
  for (const [sn, series] of Object.entries(map.series)) {
    for (const [cn, product] of Object.entries(series.products || {})) {
      const code = product.colorcode;
      if (code && !colorCodeToImage.has(code)) {
        const sku = (product.skus || []).find(s => s.productImageUrl);
        if (sku) colorCodeToImage.set(code, sku.productImageUrl);
      }
    }
  }
  
  let found = 0, notFound = 0;
  const processed = new Set(); // Track by product_id to avoid redundant checks
  
  for (const row of res.rows) {
    // Try exact SKU match first
    let rawUrl = null;
    const mapEntry = skuToMap.get(row.vendor_sku);
    if (mapEntry) {
      rawUrl = mapEntry.imageUrl;
    } else {
      // Try color code match
      const colorCode = row.vendor_sku.substring(0, 4);
      rawUrl = colorCodeToImage.get(colorCode);
    }
    
    if (!rawUrl) {
      notFound++;
      if (!processed.has(row.product_id)) {
        console.log(`NO MAP URL: ${row.collection} - ${row.name} (${row.vendor_sku})`);
        processed.add(row.product_id);
      }
      continue;
    }
    
    // Upgrade rendition URL
    const url1280 = upgradeRendition(rawUrl);
    
    // Check if product was already tested
    const cacheKey = `${row.product_id}`;
    if (processed.has(cacheKey + '_found')) {
      // Use the cached URL for this product
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'primary', $3, $4, 0, 'map-rescue')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
      `, [row.product_id, row.sku_id, url1280, rawUrl]);
      found++;
      continue;
    }
    
    if (processed.has(cacheKey + '_miss')) {
      notFound++;
      continue;
    }
    
    // Verify URL works
    let finalUrl = null;
    if (await urlExists(url1280)) {
      finalUrl = url1280;
    } else {
      // Try 570
      const url570 = url1280.replace('cq5dam.web.1280.1280.jpeg', 'cq5dam.web.570.570.jpeg');
      if (await urlExists(url570)) {
        finalUrl = url570;
      } else if (!rawUrl.includes('digitalassets.daltile.com')) {
        // Scene7 URL — use as is
        if (await urlExists(rawUrl.split('?')[0].split(':')[0])) {
          finalUrl = rawUrl.split('?')[0].split(':')[0];
        }
      }
    }
    
    if (finalUrl) {
      found++;
      processed.add(cacheKey + '_found');
      console.log(`FOUND: ${row.collection} - ${row.name} → ${finalUrl.split('/').pop().substring(0, 50)}`);
      
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'primary', $3, $4, 0, 'map-rescue')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
      `, [row.product_id, row.sku_id, finalUrl, rawUrl]);
    } else {
      notFound++;
      processed.add(cacheKey + '_miss');
      console.log(`MISS: ${row.collection} - ${row.name} (tried ${url1280.split('/').pop().substring(0, 50)})`);
    }
  }
  
  console.log(`\nFound: ${found}, Not found: ${notFound}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
