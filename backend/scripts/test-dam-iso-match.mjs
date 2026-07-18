import fs from 'fs';
import pg from 'pg';

const pool = new pg.Pool({
  host: 'localhost', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

try {
  const isoPaths = JSON.parse(fs.readFileSync('backend/data/msi-dam-iso-paths.json', 'utf8'));
  const primaryPaths = JSON.parse(fs.readFileSync('backend/data/msi-dam-paths.json', 'utf8'));

  const { rows } = await pool.query(`
    SELECT s.vendor_sku FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'MSI'
  `);
  const skuSet = new Set(rows.map(r => r.vendor_sku));
  const normalized = new Map();
  for (const r of rows) {
    normalized.set(r.vendor_sku.replace(/\//g, '-').toLowerCase(), r.vendor_sku);
  }

  function extractIsoSku(damPath) {
    const fn = damPath.split('/').pop();
    // Pattern 1: "{SKU} Iso Product Photo.ext"
    let cleaned = fn.replace(/[\s_-]*Iso[\s_-]*Product[\s_-]*Photo\.\w+$/i, '').trim();
    // Pattern 2: "{SKU}_b.ext" or "{SKU}_b_2.ext"
    if (cleaned === fn) {
      cleaned = fn.replace(/_b(?:_\d+)?\.\w+$/i, '').trim();
    }
    // Fallback: strip extension
    if (cleaned === fn) {
      cleaned = fn.replace(/\.\w+$/, '');
    }
    return cleaned;
  }

  let exact = 0, norm = 0, prefix = 0, reversePrefix = 0, noMatch = 0;
  const matchedSkus = new Set();

  for (const p of isoPaths) {
    const sku = extractIsoSku(p);

    if (skuSet.has(sku)) { exact++; matchedSkus.add(sku); continue; }

    const n = sku.replace(/\//g, '-').toLowerCase();
    if (normalized.has(n)) { norm++; matchedSkus.add(normalized.get(n)); continue; }

    let found = false;
    for (const dbSku of skuSet) {
      if (sku.startsWith(dbSku) && dbSku.length >= 8) { prefix++; matchedSkus.add(dbSku); found = true; break; }
      if (dbSku.startsWith(sku) && sku.length >= 8 && (dbSku.length - sku.length) <= 3) { reversePrefix++; matchedSkus.add(dbSku); found = true; break; }
    }
    if (!found) noMatch++;
  }

  // Also check how many of those matched SKUs already have a primary-web-image match
  const primarySkus = new Set();
  for (const p of primaryPaths) {
    const fn = p.split('/').pop();
    const sku = fn.replace(/-Primary-Web-Image\.\w+$/i, '').replace(/_Primary-Web-Image\.\w+$/i, '').replace(/\.\w+$/, '');
    if (skuSet.has(sku)) primarySkus.add(sku);
  }
  const isoWithPrimary = [...matchedSkus].filter(s => primarySkus.has(s)).length;

  console.log('═══ ISOMETRIC IMAGE MATCHING ═══');
  console.log('Total iso paths:', isoPaths.length);
  console.log('Exact:', exact);
  console.log('Normalized:', norm);
  console.log('Prefix:', prefix);
  console.log('Reverse prefix:', reversePrefix);
  console.log('No match:', noMatch);
  console.log('Unique SKUs matched:', matchedSkus.size);
  console.log('Of those, also have primary-web-image:', isoWithPrimary);
  console.log('Iso-only (no primary):', matchedSkus.size - isoWithPrimary);
  console.log('');
  console.log('This means we can add angled shots to', isoWithPrimary, 'SKUs as alternates');
  console.log('Plus', matchedSkus.size - isoWithPrimary, 'SKUs get an iso as their only image');

} finally {
  await pool.end();
}
