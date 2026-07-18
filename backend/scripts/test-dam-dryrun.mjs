/**
 * Simulated dry run of the DAM importer matching logic.
 * No Puppeteer needed — just tests the matching and reporting.
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
  const damPaths = JSON.parse(fs.readFileSync('backend/data/msi-dam-paths.json', 'utf8'));

  // Build index with normalized matching
  const { rows } = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_type,
           p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'MSI'
  `);

  const exact = new Map();
  const normalized = new Map();
  for (const row of rows) {
    exact.set(row.vendor_sku, row);
    const norm = row.vendor_sku.replace(/\//g, '-').toLowerCase();
    normalized.set(norm, row);
  }

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

  const relevant = damPaths.filter(p => {
    const cat = extractDamCategory(p);
    return cat && RELEVANT_CATEGORIES.has(cat);
  });

  // Match with all strategies
  let exactMatch = 0, normalizedMatch = 0, prefixMatch = 0, reversePrefixMatch = 0, noMatch = 0;
  let newImages = 0;
  const matchedSkuIds = new Set();

  for (const p of relevant) {
    const damSku = extractDamSku(p);
    let matchedVendorSku = null;

    // Strategy 1: Exact
    if (exact.has(damSku)) {
      exactMatch++;
      matchedVendorSku = damSku;
    }

    // Strategy 2: Normalized
    if (!matchedVendorSku) {
      const damNorm = damSku.replace(/\//g, '-').toLowerCase();
      if (normalized.has(damNorm)) {
        normalizedMatch++;
        matchedVendorSku = normalized.get(damNorm).vendor_sku;
      }
    }

    // Strategy 3: Prefix
    if (!matchedVendorSku) {
      let best = null;
      for (const [sku] of exact) {
        if (damSku.startsWith(sku) && sku.length >= 8) {
          if (!best || sku.length > best.length) best = sku;
        }
      }
      if (best) {
        prefixMatch++;
        matchedVendorSku = best;
      }
    }

    // Strategy 4: Reverse prefix
    if (!matchedVendorSku) {
      let best = null;
      for (const [sku] of exact) {
        if (sku.startsWith(damSku) && damSku.length >= 8 && (sku.length - damSku.length) <= 3) {
          if (!best || sku.length < best.length) best = sku;
        }
      }
      if (best) {
        reversePrefixMatch++;
        matchedVendorSku = best;
      }
    }

    if (!matchedVendorSku) { noMatch++; continue; }

    const entry = exact.get(matchedVendorSku);
    if (!matchedSkuIds.has(entry.sku_id)) {
      matchedSkuIds.add(entry.sku_id);
      if (!skusWithImages.has(matchedVendorSku)) newImages++;
    }
  }

  console.log('═══ DAM IMPORT DRY RUN ═══');
  console.log(`Total DAM paths:       ${damPaths.length}`);
  console.log(`Relevant categories:   ${relevant.length}`);
  console.log(`DB SKUs:               ${exact.size}`);
  console.log(`SKUs with images:      ${skusWithImages.size}`);
  console.log('');
  console.log('Matching:');
  console.log(`  Exact:               ${exactMatch}`);
  console.log(`  Normalized:          ${normalizedMatch}`);
  console.log(`  Prefix:              ${prefixMatch}`);
  console.log(`  Reverse prefix:      ${reversePrefixMatch}`);
  console.log(`  No match:            ${noMatch}`);
  console.log(`  Total matched:       ${exactMatch + normalizedMatch + prefixMatch + reversePrefixMatch}`);
  console.log(`  Unique SKUs:         ${matchedSkuIds.size}`);
  console.log(`  NEW images needed:   ${newImages}`);
  console.log('');
  console.log('Projected coverage:');
  const projected = skusWithImages.size + newImages;
  console.log(`  Current:             ${skusWithImages.size}/${exact.size} (${(skusWithImages.size/exact.size*100).toFixed(1)}%)`);
  console.log(`  After DAM import:    ${projected}/${exact.size} (${(projected/exact.size*100).toFixed(1)}%)`);
  console.log(`  Improvement:         +${newImages} SKUs`);

} finally {
  await pool.end();
}
