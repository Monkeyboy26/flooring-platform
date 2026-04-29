const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

const S7 = 'https://s7d9.scene7.com/is/image/daltile/';

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  // Get imageless SKUs with their info
  const res = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
      p.name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.sku_id = s.id AND m.asset_type = 'primary')
      AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.product_id = s.product_id AND m.sku_id IS NULL AND m.asset_type = 'primary')
      AND NOT EXISTS(SELECT 1 FROM media_assets m 
                     JOIN skus sib ON sib.id = m.sku_id 
                     WHERE sib.product_id = s.product_id AND sib.id != s.id AND m.asset_type = 'primary')
    ORDER BY p.collection, p.name
  `);
  
  console.log(`Imageless SKUs to check: ${res.rows.length}`);
  
  // Group by product to avoid duplicate work
  const byProduct = new Map();
  for (const row of res.rows) {
    const key = row.product_id;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(row);
  }
  
  let found = 0, notFound = 0;
  
  for (const [productId, skus] of byProduct) {
    const sample = skus[0];
    const colorCode = sample.vendor_sku.substring(0, 4);
    
    // Extract color name from product name (remove collection prefix)
    const colorName = sample.name
      .replace(new RegExp('^' + sample.collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '')
      .trim().replace(/\s+/g, '');
    
    // Try various Scene7 patterns at the product level
    const productCandidates = [
      `${S7}DAL_${colorCode}_${colorName}_Grid`,
      `${S7}DAL_${colorCode}_${colorName}_Silo_01`,
      `${S7}DAL_${colorCode}_${colorName}`,
      `${S7}${colorCode}_${colorName}_Grid`,
      `${S7}${colorCode}_${colorName}_Silo_01`,
      `${S7}${colorCode}_${colorName}`,
    ];
    
    // Also try with sizes from first SKU
    const sizePart = (sample.variant_name || '').split(',')[0].trim();
    const sm = sizePart.match(/^(\d+)X(\d+)$/i);
    if (sm) {
      const size = `${sm[1]}x${sm[2]}`;
      productCandidates.push(
        `${S7}DAL_${colorCode}_${size}_${colorName}_Grid`,
        `${S7}DAL_${colorCode}_${size}_${colorName}_Silo_01`,
        `${S7}DAL_${colorCode}_${size}_Grid`,
        `${S7}DAL_${colorCode}_${size}_Silo_01`,
      );
    }
    
    // Deduplicate
    const candidates = [...new Set(productCandidates)];
    
    let foundUrl = null;
    for (const url of candidates) {
      if (await urlExists(url)) {
        foundUrl = url;
        break;
      }
    }
    
    if (foundUrl) {
      found += skus.length;
      console.log(`FOUND: ${sample.collection} - ${sample.name} (${skus.length} SKUs) → ${foundUrl.split('/').pop()}`);
      
      // Insert for ALL SKUs in this product
      for (const sku of skus) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, $2, 'primary', $3, $3, 0, 'scene7-construct')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
        `, [sku.product_id, sku.sku_id, foundUrl]);
      }
    } else {
      notFound += skus.length;
      console.log(`MISS: ${sample.collection} - ${sample.name} (${skus.length} SKUs, code=${colorCode})`);
    }
  }
  
  console.log(`\nFound: ${found}, Not found: ${notFound}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
