/**
 * Quick test of DAM→SKU matching against the live database.
 * No Puppeteer needed — just loads local DAM paths and queries DB.
 */
import fs from 'fs';
import pg from 'pg';

const RELEVANT_CATEGORIES = new Set(['porcelain', 'mosaics', 'natural-stone', 'lvt', 'hardscape']);

function extractDamCategory(damPath) {
  const m = damPath.match(/\/product\/([^/]+)\//);
  return m ? m[1] : null;
}

function extractDamSku(damPath) {
  const filename = damPath.split('/').pop();
  return filename.replace(/-Primary-Web-Image\.\w+$/i, '')
                 .replace(/_Primary-Web-Image\.\w+$/i, '')
                 .replace(/\.\w+$/, '');
}

const pool = new pg.Pool({
  host: 'localhost', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

try {
  // Load DAM paths
  const damPaths = JSON.parse(fs.readFileSync('/Users/kianassarpour/Desktop/flooring-platform/backend/data/msi-dam-paths.json', 'utf8'));
  console.log('Total DAM paths:', damPaths.length);

  // Build SKU index from DB
  const { rows } = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_type,
           p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'MSI'
  `);

  const exact = new Map();
  for (const row of rows) {
    exact.set(row.vendor_sku, row);
  }
  console.log('DB SKUs:', exact.size);

  // Check existing images
  const { rows: imgRows } = await pool.query(`
    SELECT DISTINCT s.vendor_sku
    FROM media_assets ma
    JOIN skus s ON ma.sku_id = s.id
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'MSI' AND ma.asset_type = 'primary'
  `);
  const skusWithImages = new Set(imgRows.map(r => r.vendor_sku));
  console.log('SKUs already with primary image:', skusWithImages.size);

  // Filter relevant
  const relevant = damPaths.filter(p => {
    const cat = extractDamCategory(p);
    return cat && RELEVANT_CATEGORIES.has(cat);
  });
  console.log('Relevant DAM paths:', relevant.length);

  // Match
  let exactMatch = 0, prefixMatch = 0, reversePrefixMatch = 0, noMatch = 0;
  let newImages = 0; // matched AND doesn't already have image
  const matchedSkus = new Set();

  for (const p of relevant) {
    const damSku = extractDamSku(p);

    // Exact
    if (exact.has(damSku)) {
      exactMatch++;
      matchedSkus.add(damSku);
      if (!skusWithImages.has(damSku)) newImages++;
      continue;
    }

    // Prefix: DAM filename starts with a known SKU
    let found = false;
    for (const [sku] of exact) {
      if (damSku.startsWith(sku) && sku.length >= 8) {
        prefixMatch++;
        matchedSkus.add(sku);
        if (!skusWithImages.has(sku)) newImages++;
        found = true;
        break;
      }
    }
    if (found) continue;

    // Reverse prefix: known SKU starts with DAM filename
    for (const [sku] of exact) {
      if (sku.startsWith(damSku) && damSku.length >= 8 && (sku.length - damSku.length) <= 3) {
        reversePrefixMatch++;
        matchedSkus.add(sku);
        if (!skusWithImages.has(sku)) newImages++;
        found = true;
        break;
      }
    }
    if (found) continue;

    noMatch++;
  }

  console.log('\n═══ MATCHING RESULTS ═══');
  console.log('Exact:', exactMatch);
  console.log('Prefix:', prefixMatch);
  console.log('Reverse prefix:', reversePrefixMatch);
  console.log('No match:', noMatch);
  console.log('Total matched:', exactMatch + prefixMatch + reversePrefixMatch);
  console.log('Unique SKUs matched:', matchedSkus.size);
  console.log('NEW images (no existing):', newImages);
  console.log('Match rate:', ((exactMatch + prefixMatch + reversePrefixMatch) / relevant.length * 100).toFixed(1) + '%');

} finally {
  await pool.end();
}
