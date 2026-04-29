#!/usr/bin/env node
/**
 * Fix Daltile per-SKU images by constructing correct size-specific Scene7 URLs.
 *
 * For SKUs where the image URL has the right color code but wrong size,
 * constructs the correct URL by replacing the size component, then
 * verifies the URL exists via HEAD request before updating.
 *
 * Usage:
 *   node backend/scripts/fix-daltile-image-sizes.cjs --dry-run
 *   node backend/scripts/fix-daltile-image-sizes.cjs
 */
const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 10;
const DELAY_MS = 50;

// Scene7 URL size patterns: "12x24", "6x6", "24x48", etc.
const SIZE_REGEX = /(\d+)x(\d+)/gi;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Convert SKU size format "12X24" to Scene7 format "12x24"
function skuSizeToScene7(size) {
  if (!size) return null;
  const clean = size.split(',')[0].trim(); // Take first size if multi
  const m = clean.match(/^(\d+)X(\d+)$/i);
  if (!m) return null;
  return `${m[1]}x${m[2]}`;
}

// Extract the size portion from a Scene7 URL filename
function extractScene7Size(url) {
  const filename = url.split('/').pop();
  const matches = [...filename.matchAll(SIZE_REGEX)];
  if (matches.length === 0) return null;
  // Return the first size match (usually after the color code)
  return matches[0][0].toLowerCase();
}

// Replace the size in a Scene7 URL with a new size
function replaceScene7Size(url, oldSize, newSize) {
  const filename = url.split('/').pop();
  const basePath = url.substring(0, url.length - filename.length);
  // Replace the first occurrence of oldSize (case-insensitive)
  const re = new RegExp(oldSize.replace('x', 'x'), 'i');
  const newFilename = filename.replace(re, newSize);
  return basePath + newFilename;
}

// Check if a URL returns 200 via HEAD request
async function urlExists(url) {
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Process a batch of URLs concurrently
async function checkBatch(items) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (item) => {
      const exists = await urlExists(item.newUrl);
      return { ...item, exists };
    });
    results.push(...await Promise.all(promises));
    if (i + CONCURRENCY < items.length) await sleep(DELAY_MS);
  }
  return results;
}

async function main() {
  console.log(`\nDaltile Image Size Fix${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Load product map for reference
  const mapPath = path.join(__dirname, '..', 'data', 'daltile-product-map.json');
  const productMap = require(mapPath);

  // Build coveoSku → product map entry lookup
  const skuMapData = new Map();
  for (const [sn, series] of Object.entries(productMap.series)) {
    for (const [cn, product] of Object.entries(series.products || {})) {
      for (const sku of product.skus || []) {
        if (sku.coveoSku) skuMapData.set(sku.coveoSku, { ...sku, series: sn, color: cn });
      }
    }
    for (const [an, acc] of Object.entries(series.accessories || {})) {
      for (const sku of acc.skus || []) {
        if (sku.coveoSku) skuMapData.set(sku.coveoSku, { ...sku, series: sn, color: an });
      }
    }
  }

  // Get all Daltile SKUs with their primary images and size attributes
  const res = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
      m.id AS media_id, m.url AS current_url,
      sa_size.value AS size_attr
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    JOIN media_assets m ON m.sku_id = s.id AND m.asset_type = 'primary'
    LEFT JOIN sku_attributes sa_size ON sa_size.sku_id = s.id
      AND sa_size.attribute_id = (SELECT id FROM attributes WHERE slug = 'size' LIMIT 1)
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
    ORDER BY p.collection, p.name, s.vendor_sku
  `);

  console.log(`Total non-accessory SKUs with primary images: ${res.rows.length}`);

  // Categorize images
  const toFix = [];
  let perfect = 0, wrongSize = 0, noColorMatch = 0, noSize = 0, placeholder = 0;

  for (const row of res.rows) {
    const url = row.current_url;
    const colorCode = row.vendor_sku.substring(0, 4);
    const filename = url.split('/').pop();

    // Skip placeholders
    if (filename.includes('cq5dam') || filename.includes('No-Series') || filename.includes('placeholder')) {
      placeholder++;
      continue;
    }

    // Check color code match
    if (!filename.includes(colorCode)) {
      noColorMatch++;
      continue; // Can't fix these with size replacement
    }

    // Extract size from variant_name (first part before comma)
    const variantSize = (row.variant_name || '').split(',')[0].trim();
    const scene7TargetSize = skuSizeToScene7(variantSize);
    if (!scene7TargetSize) {
      noSize++;
      continue;
    }

    // Check current URL size
    const currentScene7Size = extractScene7Size(url);
    if (!currentScene7Size) {
      noSize++;
      continue;
    }

    if (currentScene7Size === scene7TargetSize) {
      perfect++;
      continue;
    }

    // Wrong size — try to construct correct URL
    wrongSize++;
    const newUrl = replaceScene7Size(url, currentScene7Size, scene7TargetSize);
    toFix.push({
      skuId: row.sku_id,
      mediaId: row.media_id,
      vendorSku: row.vendor_sku,
      variantName: row.variant_name,
      currentUrl: url,
      newUrl,
      currentSize: currentScene7Size,
      targetSize: scene7TargetSize,
    });
  }

  console.log(`\nCategories:`);
  console.log(`  Perfect match (right color + size): ${perfect}`);
  console.log(`  Wrong size (fixable): ${wrongSize}`);
  console.log(`  No color code match: ${noColorMatch}`);
  console.log(`  No size info: ${noSize}`);
  console.log(`  Placeholder images: ${placeholder}`);
  console.log(`\nVerifying ${toFix.length} constructed URLs...\n`);

  // Batch verify URLs
  const verified = await checkBatch(toFix);

  const found = verified.filter(v => v.exists);
  const notFound = verified.filter(v => !v.exists);

  console.log(`URLs verified: ${found.length} exist, ${notFound.length} don't exist`);

  // Update the ones that exist
  let updated = 0;
  for (const item of found) {
    if (DRY_RUN) {
      if (updated < 20) {
        console.log(`  FIX: ${item.vendorSku} ${item.currentSize}→${item.targetSize}`);
      }
    } else {
      await pool.query(`
        UPDATE media_assets SET url = $1, original_url = $1, source = 'size-fix'
        WHERE id = $2
      `, [item.newUrl, item.mediaId]);
    }
    updated++;
  }

  if (DRY_RUN && notFound.length > 0) {
    console.log(`\n  Not found examples (keeping current image):`);
    notFound.slice(0, 10).forEach(item => {
      console.log(`    ${item.vendorSku} (${item.variantName}): ${item.targetSize} not available`);
    });
  }

  console.log(`\n=== Summary ===`);
  console.log(`Images checked: ${res.rows.length}`);
  console.log(`Already correct: ${perfect}`);
  console.log(`Fixed (size-corrected): ${updated}`);
  console.log(`URL not found (kept current): ${notFound.length}`);
  console.log(`Placeholder (unfixable): ${placeholder}`);
  console.log(`No color match (unfixable): ${noColorMatch}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
