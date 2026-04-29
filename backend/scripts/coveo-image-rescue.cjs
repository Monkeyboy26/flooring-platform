const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

// Coveo API constants
const COVEO_ORG = 'daborpanq';
const COVEO_TOKEN = 'xx69de19c6-3f5c-45cc-8bb7-ed696b20d1aa';
const COVEO_URL = `https://${COVEO_ORG}.org.coveo.com/rest/search/v2`;

async function queryCoveo(query, maxResults = 50) {
  const body = {
    q: query,
    numberOfResults: maxResults,
    fieldsToInclude: ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'productswatchurl', 'primaryroomsceneurl', 'colorcode'],
    pipeline: 'DTProducts',
    searchHub: 'Products',
  };
  
  const r = await fetch(COVEO_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${COVEO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  
  if (!r.ok) throw new Error(`Coveo: ${r.status}`);
  return (await r.json()).results;
}

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

function cleanUrl(url) {
  if (!url) return null;
  // Remove Scene7 presets
  const cleaned = url.split('?')[0].split(':')[0];
  // Skip placeholders/tiny thumbnails
  if (cleaned.includes('cq5dam.web.170') || cleaned.includes('No-Series') || cleaned.includes('placeholder')) return null;
  return cleaned;
}

async function main() {
  // Get unique collections that have imageless products
  const res = await pool.query(`
    SELECT DISTINCT p.collection, p.name, 
      s.vendor_sku, s.id as sku_id, s.product_id
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
  
  // Group by product
  const byProduct = new Map();
  for (const row of res.rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }
  
  console.log(`Unique products: ${byProduct.size}`);
  let found = 0, notFound = 0;
  
  for (const [productId, skus] of byProduct) {
    const sample = skus[0];
    const colorCode = sample.vendor_sku.substring(0, 4);
    
    // Query Coveo for this specific product
    const results = await queryCoveo(`@colorcode=${colorCode}`, 10);
    
    let imageUrl = null;
    for (const r of results) {
      const raw = r.raw;
      const url = cleanUrl(raw.productimageurl) || cleanUrl(raw.productswatchurl);
      if (url) {
        // Quick verify
        if (await urlExists(url)) {
          imageUrl = url;
          break;
        }
      }
    }
    
    if (imageUrl) {
      found += skus.length;
      console.log(`FOUND: ${sample.collection} - ${sample.name} (${skus.length} SKUs) → ${imageUrl.split('/').pop().substring(0, 50)}`);
      
      for (const sku of skus) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, $2, 'primary', $3, $3, 0, 'coveo-rescue')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
        `, [sku.product_id, sku.sku_id, imageUrl]);
      }
    } else {
      notFound += skus.length;
      if (results.length === 0) {
        console.log(`NO COVEO RESULTS: ${sample.collection} - ${sample.name} (code=${colorCode})`);
      } else {
        console.log(`MISS: ${sample.collection} - ${sample.name} (${skus.length} SKUs) — Coveo has ${results.length} results but no working images`);
      }
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`\nFound: ${found}, Not found: ${notFound}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
