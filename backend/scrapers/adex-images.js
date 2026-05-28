#!/usr/bin/env node

/**
 * ADEX USA — Image Scraper (Product Map edition)
 *
 * Consumes the pre-built product map (backend/data/adex-product-map.json)
 * to assign images per SKU:
 *
 * Phase 1: Load product map + build lookups
 * Phase 2: Match SKUs by vendor_sku → product.code, save primary image
 * Phase 3: Disperse subserie gallery images as lifestyle to linked products
 * Phase 4: Disperse inspiration gallery images as lifestyle to linked products
 *
 * Usage:
 *   docker compose exec api node scrapers/adex-images.js [--dry-run] [collection]
 *   collection: floor | habitat | hampton | horizon | levante | mosaic | neri | ocean | studio | all (default)
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { upsertMediaAsset } from './base.js';

// ==================== Config ====================

const COLLECTIONS = [
  'floor', 'habitat', 'hampton', 'horizon',
  'levante', 'mosaic', 'neri', 'ocean', 'studio',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRODUCT_MAP_PATH = join(__dirname, '..', 'data', 'adex-product-map.json');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Main ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetCollection = args.find(a => a !== '--dry-run')?.toLowerCase();

  const collections = targetCollection && targetCollection !== 'all'
    ? [targetCollection]
    : COLLECTIONS;

  if (dryRun) console.log('DRY RUN — no DB writes\n');

  // ── Phase 1: Load product map + build lookups ──
  console.log('Phase 1: Loading product map...');
  let productMap;
  try {
    productMap = JSON.parse(readFileSync(PRODUCT_MAP_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Failed to load product map from ${PRODUCT_MAP_PATH}`);
    console.error('Run: node backend/scripts/build-adex-product-map.cjs');
    process.exit(1);
  }

  // Build lookup: vendor_sku → { imageUrl }
  const codeLookup = {};
  // Build lookup: detailUrl → vendor_sku (for subserie gallery product links)
  const detailUrlToCode = {};
  for (const [collName, collData] of Object.entries(productMap.collections)) {
    for (const [colorName, colorData] of Object.entries(collData.colors)) {
      for (const product of colorData.products) {
        if (!product.code) continue;
        codeLookup[product.code] = {
          imageUrl: product.imageUrl,
        };
        if (product.detailUrl) {
          const normalized = product.detailUrl.trim().replace(/\/\s*$/, '');
          detailUrlToCode[normalized] = product.code;
        }
      }
    }
  }
  console.log(`  Loaded ${Object.keys(codeLookup).length} product codes from map`);
  console.log(`  Loaded ${Object.keys(detailUrlToCode).length} detail URL mappings`);
  console.log(`  Map generated: ${productMap.generated}\n`);

  // ── Load all ADEX SKUs from DB ──
  const dbResult = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.variant_name,
           p.collection, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ADEX' AND s.status = 'active'
  `);
  console.log(`Loaded ${dbResult.rows.length} ADEX SKUs from DB\n`);

  // Build vendor_sku → { sku_id, product_id } lookup
  const skuLookup = {};
  for (const row of dbResult.rows) {
    skuLookup[row.vendor_sku] = { sku_id: row.sku_id, product_id: row.product_id };
  }

  // Group SKUs by collection
  const skusByCollection = {};
  for (const row of dbResult.rows) {
    const coll = (row.collection || '').toLowerCase();
    if (!skusByCollection[coll]) skusByCollection[coll] = [];
    skusByCollection[coll].push(row);
  }

  // Track lifestyle sort_order per SKU to avoid conflicts
  const skuLifestyleIdx = {};
  function nextLifestyleSort(skuId) {
    const idx = skuLifestyleIdx[skuId] || 0;
    skuLifestyleIdx[skuId] = idx + 1;
    return idx;
  }

  // Track saved lifestyle images to avoid duplicates (sku_id|imageUrl)
  const savedLifestyle = new Set();

  // ── Phase 2: Process each collection (primary images) ──
  const totals = { matched: 0, imagesSaved: 0, noMatch: 0 };

  for (const collection of collections) {
    const collSkus = skusByCollection[collection] || [];
    if (collSkus.length === 0) {
      console.log(`  ${collection.toUpperCase()}: no SKUs in DB, skipping`);
      continue;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${collection.toUpperCase()} — ${collSkus.length} SKUs`);
    console.log(`${'═'.repeat(60)}`);

    let matched = 0, noMatch = 0, imagesSaved = 0;

    console.log(`\n  Phase 2: Matching SKUs by vendor_sku`);

    for (const row of collSkus) {
      const mapEntry = codeLookup[row.vendor_sku];
      if (!mapEntry) {
        noMatch++;
        if (noMatch <= 5) {
          console.log(`    SKIP: ${row.vendor_sku} (${row.variant_name}) — not in product map`);
        }
        continue;
      }

      matched++;

      if (dryRun) {
        if (matched <= 3) {
          const imgFile = mapEntry.imageUrl ? mapEntry.imageUrl.split('/').pop() : 'none';
          console.log(`    MATCH: ${row.vendor_sku} → primary: ${imgFile.slice(-50)}`);
        }
      }

      // Save product card image as primary (sort_order 0)
      if (mapEntry.imageUrl && !dryRun) {
        await upsertMediaAsset(pool, {
          product_id: row.product_id,
          sku_id: row.sku_id,
          asset_type: 'primary',
          url: mapEntry.imageUrl,
          original_url: mapEntry.imageUrl,
          sort_order: 0,
        });
        imagesSaved++;
      }
    }

    if (noMatch > 5) console.log(`    ... and ${noMatch - 5} more unmatched`);
    console.log(`  Matched: ${matched} SKUs, ${imagesSaved} images saved, ${noMatch} unmatched`);

    totals.matched += matched;
    totals.imagesSaved += imagesSaved;
    totals.noMatch += noMatch;
  }

  // ── Phase 3: Disperse subserie gallery images as lifestyle ──
  console.log('\n' + '═'.repeat(60));
  console.log('  Phase 3: Subserie gallery → lifestyle images');
  console.log('═'.repeat(60));

  let galleryDisperseCount = 0;
  let gallerySkipCount = 0;

  for (const [collName, collData] of Object.entries(productMap.collections)) {
    if (targetCollection && targetCollection !== 'all' && collName !== targetCollection) continue;

    for (const [colorName, colorData] of Object.entries(collData.colors)) {
      for (const galleryImg of colorData.galleryImages) {
        if (!galleryImg.products || galleryImg.products.length === 0) {
          gallerySkipCount++;
          continue;
        }

        for (const linkedProduct of galleryImg.products) {
          // Match by detail URL → product code → SKU
          const normalizedUrl = (linkedProduct.detailUrl || '').trim().replace(/\/\s*$/, '');
          const code = detailUrlToCode[normalizedUrl];
          if (!code) continue;

          const sku = skuLookup[code];
          if (!sku) continue;

          // Avoid saving same image to same SKU twice
          const key = `${sku.sku_id}|${galleryImg.url}`;
          if (savedLifestyle.has(key)) continue;
          savedLifestyle.add(key);

          const sortOrder = nextLifestyleSort(sku.sku_id);

          if (!dryRun) {
            await upsertMediaAsset(pool, {
              product_id: sku.product_id,
              sku_id: sku.sku_id,
              asset_type: 'lifestyle',
              url: galleryImg.url,
              original_url: galleryImg.url,
              sort_order: sortOrder,
            });
          }
          galleryDisperseCount++;
        }
      }
    }
  }

  console.log(`  Gallery images dispersed: ${galleryDisperseCount} lifestyle saves`);
  console.log(`  Gallery images skipped (no products): ${gallerySkipCount}`);

  // ── Phase 4: Inspiration gallery → lifestyle images ──
  console.log('\n' + '═'.repeat(60));
  console.log('  Phase 4: Inspiration gallery → lifestyle images');
  console.log('═'.repeat(60));

  let inspirationCount = 0;
  const inspirationGallery = productMap.inspirationGallery || [];

  if (inspirationGallery.length === 0) {
    console.log('  No inspiration gallery data in product map. Skipping.');
  } else {
    for (const entry of inspirationGallery) {
      if (!entry.imageUrl || !entry.productCodes || entry.productCodes.length === 0) continue;

      // Filter by target collection if specified
      if (targetCollection && targetCollection !== 'all') {
        const entryColl = (entry.collection || '').toLowerCase();
        if (entryColl !== targetCollection) continue;
      }

      for (const code of entry.productCodes) {
        const sku = skuLookup[code];
        if (!sku) continue;

        // Avoid saving same image to same SKU twice
        const key = `${sku.sku_id}|${entry.imageUrl}`;
        if (savedLifestyle.has(key)) continue;
        savedLifestyle.add(key);

        const sortOrder = nextLifestyleSort(sku.sku_id);

        if (!dryRun) {
          await upsertMediaAsset(pool, {
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            asset_type: 'lifestyle',
            url: entry.imageUrl,
            original_url: entry.imageUrl,
            sort_order: sortOrder,
          });
        }
        inspirationCount++;
      }
    }
    console.log(`  Inspiration images dispersed: ${inspirationCount} lifestyle saves`);
  }

  // ── Summary ──
  console.log('\n=== ADEX Image Scrape Complete ===');
  console.log(`Collections processed:   ${collections.length}`);
  console.log(`SKUs matched:            ${totals.matched}`);
  console.log(`Primary images saved:    ${totals.imagesSaved}`);
  console.log(`SKUs not in product map: ${totals.noMatch}`);
  console.log(`Gallery lifestyle saves: ${galleryDisperseCount}`);
  console.log(`Inspiration lifestyle:   ${inspirationCount}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
