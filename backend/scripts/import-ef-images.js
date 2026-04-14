#!/usr/bin/env node

/**
 * Import Engineered Floors — Product Imagery from CSV + Cloudinary
 *
 * Two modes:
 *   --csv <path>   Import from EF_Full_Product_Catalog.csv (default)
 *   --api          Fetch from Cloudinary Search API (EF_CLOUDINARY_API_KEY required)
 *
 * Matches CSV rows to existing EF SKUs in the database by:
 *   - CSV "Product SKU" (style number) → DB vendor_sku part 2 (e.g., "1324")
 *   - CSV image filename color number   → DB vendor_sku part 3 (e.g., "528")
 *
 * Image type mapping:
 *   - "Swatch"     → asset_type 'primary' (main product image, sort_order 0)
 *   - "Room Scene"  → asset_type 'lifestyle' (room scene, sort_order 0+)
 *
 * Usage:
 *   node backend/scripts/import-ef-images.js --csv /path/to/EF_Full_Product_Catalog.csv
 *   node backend/scripts/import-ef-images.js --csv /path/to/EF_Full_Product_Catalog.csv --dry-run
 *   node backend/scripts/import-ef-images.js --api
 */

import pg from 'pg';
import fs from 'fs';
import https from 'https';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_CODE = 'EF';
const DRY_RUN = process.argv.includes('--dry-run');
const USE_API = process.argv.includes('--api');

// ---------------------------------------------------------------------------
// Media asset upsert (same pattern as import-pentz-commercial.js)
// ---------------------------------------------------------------------------

async function upsertMediaAsset({ product_id, sku_id, asset_type, url, sort_order }) {
  if (!url) return;
  if (url.startsWith('http://')) url = url.replace('http://', 'https://');
  const at = asset_type || 'primary';
  const so = sort_order || 0;

  if (sku_id) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, sku_id, at, url, so]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, NULL, $2, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, at, url, so]);
  }
}

// ---------------------------------------------------------------------------
// Load EF SKU lookup from database
// ---------------------------------------------------------------------------

async function loadEfSkuMap() {
  const res = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1
  `, [VENDOR_CODE]);

  // Build lookup: "styleNum:colorNum" → { sku_id, product_id, ... }
  const map = new Map();
  for (const row of res.rows) {
    const parts = row.vendor_sku.split('-');
    // vendor_sku format: 1-{styleNum}-{colorNum}-1200-A
    if (parts.length >= 3) {
      const key = `${parts[1]}:${parts[2]}`;
      map.set(key, row);
    }
  }
  console.log(`  Loaded ${res.rows.length} EF SKUs (${map.size} unique style:color keys)`);
  return map;
}

// ---------------------------------------------------------------------------
// Extract color number from Cloudinary filename
// ---------------------------------------------------------------------------

function extractColorFromFilename(url) {
  // Filenames like:
  //   1324_528_x7t1t2.jpg              (swatch: {style}_{color}_{hash})
  //   1324_Acclaim_528_Cinnamon_Tea_RS  (room scene: {style}_{name}_{color}_{colorName}_RS)
  //   6372_4014_xplvcq.jpg             (swatch, different style number)
  if (!url) return null;
  const filename = url.split('/').pop().split('.')[0];

  // Pattern 1: "{digits}_{digits}_{hash}" — swatch format
  const swatchMatch = filename.match(/^\d+_(\d{2,5})_/);
  if (swatchMatch) return swatchMatch[1];

  // Pattern 2: "{digits}_{Name}_{digits}_{ColorName}" — room scene format
  const rsMatch = filename.match(/^\d+_[A-Za-z]+_(\d{2,5})_/);
  if (rsMatch) return rsMatch[1];

  return null;
}

// ---------------------------------------------------------------------------
// CSV Import
// ---------------------------------------------------------------------------

/**
 * Simple CSV parser that handles quoted fields (no external deps).
 * Returns array of objects keyed by header names.
 */
function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());

  const splitRow = (line) => {
    line = line.replace(/\r$/, '');
    const fields = [];
    let field = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { field += '"'; i++; }
        else q = !q;
      } else if (ch === ',' && !q) {
        fields.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = splitRow(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (values[i] || '').trim(); });
    return obj;
  });
}

async function importFromCsv(csvPath) {
  console.log(`\nReading CSV: ${csvPath}`);
  const content = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCsv(content);
  console.log(`  Parsed ${rows.length} rows`);

  const skuMap = await loadEfSkuMap();

  // Build secondary lookup: "styleNum:colorName" (lowercased) for fallback matching
  const nameMap = new Map();
  const res = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, LOWER(s.variant_name) as variant_lower
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1
  `, [VENDOR_CODE]);
  for (const row of res.rows) {
    const parts = row.vendor_sku.split('-');
    if (parts.length >= 3 && row.variant_lower) {
      nameMap.set(`${parts[1]}:${row.variant_lower}`, row);
    }
  }

  const stats = { matched: 0, unmatched: 0, swatches: 0, roomScenes: 0, skipped: 0, byColor: 0, byName: 0 };
  const roomSceneCounters = new Map();

  for (const row of rows) {
    const productSku = (row['Product SKU'] || '').trim();
    const imageUrl = (row['Image Sample URL'] || '').trim();
    const imageType = (row['Image Type'] || '').trim();
    const colorName = (row['Color Name'] || '').trim();

    if (!productSku || !imageUrl) {
      stats.skipped++;
      continue;
    }

    // Strategy 1: Extract color number from filename → match by style:color
    const colorNum = extractColorFromFilename(imageUrl);
    let sku = colorNum ? skuMap.get(`${productSku}:${colorNum}`) : null;

    // Strategy 2: Fall back to matching by style + variant_name
    if (!sku && colorName) {
      sku = nameMap.get(`${productSku}:${colorName.toLowerCase()}`);
      if (sku) stats.byName++;
    }
    if (sku && colorNum) stats.byColor++;

    if (!sku) {
      stats.unmatched++;
      continue;
    }

    stats.matched++;

    // Determine asset_type and sort_order
    let asset_type, sort_order;
    if (imageType === 'Swatch') {
      asset_type = 'primary';
      sort_order = 0;
      stats.swatches++;
    } else {
      // Room Scene → lifestyle
      asset_type = 'lifestyle';
      const counterKey = `${sku.sku_id}:lifestyle`;
      const current = roomSceneCounters.get(counterKey) || 0;
      sort_order = current;
      roomSceneCounters.set(counterKey, current + 1);
      stats.roomScenes++;
    }

    if (!DRY_RUN) {
      await upsertMediaAsset({
        product_id: sku.product_id,
        sku_id: sku.sku_id,
        asset_type,
        url: imageUrl,
        sort_order,
      });
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Cloudinary Search API Import
// ---------------------------------------------------------------------------

function cloudinaryRequest(body) {
  const apiKey = process.env.EF_CLOUDINARY_API_KEY;
  const apiSecret = process.env.EF_CLOUDINARY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('EF_CLOUDINARY_API_KEY and EF_CLOUDINARY_API_SECRET must be set');
  }

  const data = JSON.stringify(body);
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudinary.com',
      path: '/v1_1/engineeredfloors/resources/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Cloudinary API ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Cloudinary timeout')); });
    req.write(data);
    req.end();
  });
}

async function importFromCloudinaryApi() {
  console.log('\nFetching from Cloudinary Search API...');

  const skuMap = await loadEfSkuMap();

  // Build variant name lookup for fallback
  const nameMap = new Map();
  const dbRes = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, LOWER(s.variant_name) as variant_lower
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1
  `, [VENDOR_CODE]);
  for (const row of dbRes.rows) {
    const parts = row.vendor_sku.split('-');
    if (parts.length >= 3 && row.variant_lower) {
      nameMap.set(`${parts[1]}:${row.variant_lower}`, row);
    }
  }

  const stats = { matched: 0, unmatched: 0, swatches: 0, roomScenes: 0, skipped: 0, apiCalls: 0, byColor: 0, byName: 0 };
  const roomSceneCounters = new Map();

  // Fetch swatches and room scenes
  for (const imageType of ['swatches', 'room_scenes']) {
    let nextCursor = null;

    do {
      const body = {
        expression: `metadata.image_type=${imageType}`,
        max_results: 100,
        with_field: 'metadata',
      };
      if (nextCursor) body.next_cursor = nextCursor;

      const result = await cloudinaryRequest(body);
      stats.apiCalls++;
      console.log(`  API call #${stats.apiCalls}: ${result.resources?.length || 0} resources (total: ${result.total_count})`);

      for (const resource of (result.resources || [])) {
        const url = resource.secure_url || resource.url;
        const meta = resource.metadata || {};
        const productId = meta.product_id;         // EF internal ID (numeric, e.g. "2828")
        const metaSku = meta.sku || '';             // e.g. "Goose Hill 2828" or "L060 Restore"
        const productColor = meta.product_color || '';

        if (!url || (!productId && !metaSku)) {
          stats.skipped++;
          continue;
        }

        // Build list of candidate style numbers to try:
        // 1. product_id (works for carpet where product_id IS the style number)
        // 2. Leading alpha-numeric code from sku (hard surface: "L060 Restore" → "L060")
        // 3. Leading numeric code from sku ("1238 Nimbus" → "1238", "4032 Star Struck" → "4032")
        // 4. Trailing number from sku (carpet: "Goose Hill 2828" → "2828")
        // 5. All numbers from multi-sku ("Mirage I 6740, Mirage II 6750" → [6740, 6750])
        const styleKeys = new Set();
        if (productId && productId !== '0000') styleKeys.add(productId);

        // Handle comma-separated multi-sku entries first
        const skuParts = metaSku.split(/,\s*/);
        for (const part of skuParts) {
          // Alpha-numeric leading code: "L060 Restore", "D2026 American Standard"
          const alphaMatch = part.match(/^([A-Z]\w{2,6})\s/i);
          if (alphaMatch) styleKeys.add(alphaMatch[1]);

          // Numeric leading code: "1238 Nimbus", "4032 Star Struck"
          const numLeadMatch = part.match(/^(\d{3,5})\s/);
          if (numLeadMatch) styleKeys.add(numLeadMatch[1]);

          // Trailing number: "Goose Hill 2828", "Baja II 8748"
          const trailingMatch = part.match(/\s(\d{3,5})$/);
          if (trailingMatch) styleKeys.add(trailingMatch[1]);
        }

        // Extract color number from product_color (e.g., "6608 Bristol" → "6608")
        const colorFromMeta = productColor.match(/^(\d{2,5})\s/) ? productColor.match(/^(\d{2,5})\s/)[1] : null;
        // Extract color from filename
        const colorNum = extractColorFromFilename(url);

        let sku = null;

        // Try each style key with each color source
        for (const styleKey of styleKeys) {
          if (sku) break;

          // Strategy 1: color from filename
          if (colorNum) {
            sku = skuMap.get(`${styleKey}:${colorNum}`);
          }

          // Strategy 2: color from product_color metadata
          if (!sku && colorFromMeta) {
            sku = skuMap.get(`${styleKey}:${colorFromMeta}`);
          }

          // Strategy 3: color name from product_color → variant_name
          if (!sku && productColor) {
            const colorName = productColor.replace(/^\d+\s+/, '').toLowerCase();
            if (colorName) {
              sku = nameMap.get(`${styleKey}:${colorName}`);
            }
          }
        }

        if (sku && (colorNum || colorFromMeta)) stats.byColor++;
        else if (sku) stats.byName++;

        if (!sku) {
          stats.unmatched++;
          if (stats.unmatched <= 20) {
            console.log(`    MISS: product_id=${productId} sku="${metaSku}" color="${productColor}" keys=[${[...styleKeys].join(',')}]`);
          }
          continue;
        }

        stats.matched++;

        let asset_type, sort_order;
        if (imageType === 'swatches') {
          asset_type = 'primary';
          sort_order = 0;
          stats.swatches++;
        } else {
          asset_type = 'lifestyle';
          const counterKey = `${sku.sku_id}:lifestyle`;
          const current = roomSceneCounters.get(counterKey) || 0;
          sort_order = current;
          roomSceneCounters.set(counterKey, current + 1);
          stats.roomScenes++;
        }

        if (!DRY_RUN) {
          await upsertMediaAsset({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            asset_type,
            url,
            sort_order,
          });
        }
      }

      nextCursor = result.next_cursor || null;
    } while (nextCursor);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Engineered Floors — Image Import${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}`);

  let stats;

  if (USE_API) {
    stats = await importFromCloudinaryApi();
  } else {
    // Find CSV path from --csv arg or default
    const csvArgIdx = process.argv.indexOf('--csv');
    const csvPath = csvArgIdx >= 0 && process.argv[csvArgIdx + 1]
      ? process.argv[csvArgIdx + 1]
      : 'backend/data/EF_Full_Product_Catalog.csv';

    if (!fs.existsSync(csvPath)) {
      console.error(`CSV file not found: ${csvPath}`);
      console.error('Usage: node backend/scripts/import-ef-images.js --csv /path/to/EF_Full_Product_Catalog.csv');
      process.exit(1);
    }

    stats = await importFromCsv(csvPath);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Results:');
  console.log(`  Matched & imported: ${stats.matched} images`);
  console.log(`    Swatches (primary):      ${stats.swatches}`);
  console.log(`    Room Scenes (lifestyle): ${stats.roomScenes}`);
  if (stats.byColor || stats.byName) {
    console.log(`    Matched by color num:    ${stats.byColor}`);
    console.log(`    Matched by variant name: ${stats.byName}`);
  }
  console.log(`  Unmatched:  ${stats.unmatched}`);
  console.log(`  Skipped:    ${stats.skipped}`);
  if (stats.apiCalls) console.log(`  API calls:  ${stats.apiCalls}`);
  console.log(`${'='.repeat(60)}\n`);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
