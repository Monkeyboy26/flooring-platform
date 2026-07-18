#!/usr/bin/env node
/**
 * Scrape MegaClic product images from megaclicfloors.com
 *
 * Visits each collection page to discover product links, then visits each
 * product detail page to extract the two main images:
 *   - Image 1 (et_pb_image_0_tb_body): product close-up → primary
 *   - Image 2 (et_pb_image_1_tb_body): room scene → lifestyle
 *
 * Updates media_assets in the database for matching MegaClic SKUs.
 *
 * Usage: docker compose exec api node scripts/scrape-megaclic-images.js [--dry-run]
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 800; // polite delay between requests

// ── Collection pages ──────────────────────────────────────────────────────
const COLLECTIONS = [
  { url: 'https://www.megaclicfloors.com/vinyl/athens/',                                   name: 'Athens' },
  { url: 'https://www.megaclicfloors.com/vinyl/abbey-road/',                                name: 'Abbey Road' },
  { url: 'https://www.megaclicfloors.com/waterproof-laminate-main/waterproof-laminate/',    name: 'AquaShield AC5' },
  { url: 'https://www.megaclicfloors.com/waterproof-laminate-main/aquashield-12mm-ac4/',    name: 'AquaShield AC4' },
  { url: 'https://www.megaclicfloors.com/waterproof-laminate-main/centennial-ac4/',         name: 'Centennial AC4' },
  { url: 'https://www.megaclicfloors.com/waterproof-laminate-main/diana-10mm-ac4/',         name: 'Diana AC4' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTML helpers ──────────────────────────────────────────────────────────

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Roma Flooring PIM image sync)' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

/** Extract product page links (/project/...) from a collection page */
function extractProductLinks(html) {
  const links = new Set();
  const re = /href="(https:\/\/www\.megaclicfloors\.com\/project\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) links.add(m[1]);
  return [...links];
}

/** Extract vendor SKU from page title (e.g. "MCGL-8502 Laguna - Megaclicfloor") */
function extractSkuFromTitle(html) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (!titleMatch) return null;
  const title = titleMatch[1];
  // Match SKU patterns: MCGL-XXXX, MCAS-XXXX, MCCT-XXXX, MCDN-XXXX
  const skuMatch = title.match(/\b(MC[A-Z]{2}-\d{4})\b/i);
  return skuMatch ? skuMatch[1].toUpperCase() : null;
}

/**
 * Extract the two main images from a product detail page.
 * Divi renders them as et_pb_image_0_tb_body and et_pb_image_1_tb_body.
 */
function extractProductImages(html) {
  const images = [];

  // Strategy 1: Match et_pb_image modules by class order
  // The first et_pb_image in the body template is the product photo,
  // the second is the room scene
  const imgModuleRe = /et_pb_image_(\d+)_tb_body[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/g;
  let m;
  const moduleImages = [];
  while ((m = imgModuleRe.exec(html))) {
    const idx = parseInt(m[1]);
    const src = m[2];
    if (src.includes('wp-content/uploads')) {
      moduleImages.push({ idx, src });
    }
  }

  // Sort by module index
  moduleImages.sort((a, b) => a.idx - b.idx);

  if (moduleImages.length >= 2) {
    return { primary: moduleImages[0].src, lifestyle: moduleImages[1].src };
  }
  if (moduleImages.length === 1) {
    return { primary: moduleImages[0].src, lifestyle: null };
  }

  // Strategy 2: Fallback — find first two large images in wp-content/uploads
  const imgRe = /<img[^>]+src="(https:\/\/www\.megaclicfloors\.com\/wp-content\/uploads\/[^"]+)"/g;
  const allImages = [];
  while ((m = imgRe.exec(html))) {
    const src = m[1];
    // Skip thumbnails (1080x810 or smaller in URL) — prefer full-size
    if (!allImages.includes(src)) allImages.push(src);
  }

  return {
    primary: allImages[0] || null,
    lifestyle: allImages[1] || null,
  };
}

/** Upgrade image URL to full-size (remove WP thumbnail suffix) */
function fullSizeUrl(url) {
  if (!url) return null;
  // Remove WordPress thumbnail dimensions like -1080x810, -scaled-2-1
  // but keep -1-scaled.jpg (that's the full-size pattern)
  return url
    .replace(/-\d+x\d+(\.\w+)$/, '$1') // -1080x810.jpg → .jpg
    .replace(/-scaled-\d+-\d+(\.\w+)$/, '-scaled$1'); // -scaled-2-1.png → -scaled.png
}

// ── Database helpers ──────────────────────────────────────────────────────

async function getVendorId() {
  const r = await pool.query(`SELECT id FROM vendors WHERE code = 'MEGACLIC'`);
  return r.rows[0]?.id;
}

async function getSkuMap(vendorId) {
  const r = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND COALESCE(s.variant_type, '') != 'accessory'
  `, [vendorId]);
  const map = {};
  for (const row of r.rows) {
    map[row.vendor_sku.toUpperCase()] = { skuId: row.sku_id, productId: row.product_id };
  }
  return map;
}

async function upsertMedia(productId, skuId, assetType, url, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, $3, $4, $4, $5)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
  `, [productId, skuId, assetType, url, sortOrder]);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`scrape-megaclic-images.js — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  const vendorId = await getVendorId();
  if (!vendorId) { console.error('MegaClic vendor not found'); process.exit(1); }

  const skuMap = await getSkuMap(vendorId);
  console.log(`Loaded ${Object.keys(skuMap).length} active MegaClic flooring SKUs\n`);

  let totalScraped = 0, totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

  for (const collection of COLLECTIONS) {
    console.log(`\n--- ${collection.name} ---`);
    console.log(`  Fetching ${collection.url}`);

    let collectionHtml;
    try {
      collectionHtml = await fetchPage(collection.url);
    } catch (err) {
      console.error(`  ERROR fetching collection: ${err.message}`);
      totalErrors++;
      continue;
    }

    const productLinks = extractProductLinks(collectionHtml);
    console.log(`  Found ${productLinks.length} product links`);

    for (const link of productLinks) {
      await sleep(DELAY_MS);

      let html;
      try {
        html = await fetchPage(link);
      } catch (err) {
        console.error(`  ERROR fetching ${link}: ${err.message}`);
        totalErrors++;
        continue;
      }

      const vendorSku = extractSkuFromTitle(html);
      if (!vendorSku) {
        console.log(`  SKIP ${link} — no SKU in title`);
        totalSkipped++;
        continue;
      }

      const skuInfo = skuMap[vendorSku];
      if (!skuInfo) {
        console.log(`  SKIP ${vendorSku} — not in database`);
        totalSkipped++;
        continue;
      }

      const images = extractProductImages(html);
      const primary = fullSizeUrl(images.primary);
      const lifestyle = fullSizeUrl(images.lifestyle);

      totalScraped++;

      if (DRY_RUN) {
        console.log(`  ${vendorSku}: primary=${primary ? '✓' : '✗'}  lifestyle=${lifestyle ? '✓' : '✗'}`);
        if (primary) console.log(`    → ${primary}`);
        if (lifestyle) console.log(`    → ${lifestyle}`);
      } else {
        if (primary) {
          await upsertMedia(skuInfo.productId, skuInfo.skuId, 'primary', primary, 0);
        }
        if (lifestyle) {
          await upsertMedia(skuInfo.productId, skuInfo.skuId, 'lifestyle', lifestyle, 1);
        }
        totalUpdated++;
        console.log(`  ${vendorSku}: primary=${primary ? '✓' : '✗'}  lifestyle=${lifestyle ? '✓' : '✗'}`);
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Products scraped: ${totalScraped}`);
  console.log(`Database updated: ${totalUpdated}`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log(`Errors: ${totalErrors}`);
  console.log('Done!');

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
