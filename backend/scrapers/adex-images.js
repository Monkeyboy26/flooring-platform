#!/usr/bin/env node

/**
 * ADEX USA — Color + Lifestyle Image Scraper
 *
 * Replaces B&W outline drawings with actual color photos from subseries pages
 * and captures lifestyle/room-scene images.
 *
 * Phase 1: Build color image map from subseries gallery pages
 *   - For each collection, visit subseries pages (by color)
 *   - Extract ALL gallery images matching {Collection}-{Color}...-en-... pattern
 *   - Collect non-color-matched images as lifestyle candidates
 *   - Special case: Mosaic subseries on the page are shapes, not colors —
 *     construct color URLs from DB variant_names instead
 *
 * Phase 2: Match images to SKUs by collection + variant_name
 *   - Save first color image as primary, extras as alternate (up to 4 per SKU)
 *
 * Phase 3: Demote existing B&W outlines from primary to alternate
 *
 * Phase 4: Save lifestyle/room-scene images at the product level
 *   - Non-color-matched images from subseries pages (bathroom, kitchen, etc.)
 *   - Saved as 'lifestyle' asset type for all products in the collection
 *
 * Phase 5: Save collection brochure PDFs as spec_pdf assets
 *   - Extract S3-hosted PDF links from each collection page
 *   - Save as product-level spec_pdf for every product in that collection
 *
 * Usage:
 *   docker compose exec api node scrapers/adex-images.js [--dry-run] [collection]
 *   collection: floor | habitat | hampton | horizon | levante | mosaic | neri | ocean | studio | all (default)
 */

import pg from 'pg';
import { upsertMediaAsset } from './base.js';

// ==================== Config ====================

const BASE_URL = 'https://adexusa.com';
const DELAY_MS = 400;

const COLLECTIONS = [
  'floor', 'habitat', 'hampton', 'horizon',
  'levante', 'mosaic', 'neri', 'ocean', 'studio',
];

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Helpers ====================

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url) {
  await delay(DELAY_MS);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!resp.ok) {
    console.warn(`  WARN: ${resp.status} for ${url}`);
    return null;
  }
  return await resp.text();
}

/**
 * Strip WordPress image size suffix to get original resolution.
 * "image-en-hash-1024x257.jpg" → "image-en-hash.jpg"
 */
function stripWpSizeSuffix(url) {
  return url.replace(/-\d+x\d+(\.\w+)$/, '$1');
}

/**
 * Extract subseries names from a collection page.
 * Looks for links like ?subserie=Frost Glossy
 */
function extractSubseries(html) {
  const subseries = new Set();
  const re = /[?&]subserie=([^"&]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = decodeURIComponent(m[1]).trim();
    if (name) subseries.add(name);
  }
  return [...subseries];
}

/**
 * Extract all images from a subseries page HTML, split into color-specific
 * and lifestyle categories.
 *
 * Color strategies:
 *   Strategy 1 — filename contains {Collection}-{Color} (Studio, Neri, Habitat, etc.):
 *     "Studio-Almond-1-en-TYsI3yDDOtJ2BA6l.jpg"
 *   Strategy 2 — numbered collection images (Horizon, Floor):
 *     "Horizon-10-en-RLXAEW5kBH5m6pdp.jpg"
 *
 * Returns { colorImages: [...], lifestyleImages: [...] }
 */
function extractPageImages(html, collectionName, subseriesName) {
  // Collect all candidate wp-content -en- images
  const candidates = [];
  const imgRe = /(https?:\/\/adexusa\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s]+\.(?:jpg|jpeg|png|webp))/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const rawUrl = m[1];
    if (/logo|favicon|fav-icon|icon/i.test(rawUrl)) continue;
    const filename = rawUrl.split('/').pop();
    if (!filename.includes('-en-')) continue;
    candidates.push(stripWpSizeSuffix(rawUrl));
  }
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return { colorImages: [], lifestyleImages: [] };

  const collLower = collectionName.toLowerCase();
  const bareRe = new RegExp(`^${collectionName}-?en-`, 'i');
  const colorImageSet = new Set();
  let colorImages = [];

  // Strategy 1: Match by {Collection}{Color} pattern (most collections)
  const expected = (collectionName + subseriesName).toLowerCase().replace(/[\s-]+/g, '');
  const patternMatches = unique.filter(url => {
    const norm = url.split('/').pop().toLowerCase().replace(/-/g, '');
    return norm.startsWith(expected);
  });
  if (patternMatches.length > 0) {
    colorImages = patternMatches;
  } else {
    // Strategy 2: Grab numbered collection images (Horizon, Floor)
    colorImages = unique.filter(url => {
      const fn = url.split('/').pop();
      if (!fn.toLowerCase().startsWith(collLower)) return false;
      if (bareRe.test(fn)) return false;
      if (/project|bath|kitchen|living|gentleman|gentlemen|geometric|decor/i.test(fn)) return false;
      return true;
    });
  }

  for (const url of colorImages) colorImageSet.add(url);

  // Lifestyle: remaining images that aren't color-matched or collection headers.
  // Prefer images with room-scene keywords; skip other product color shots.
  const lifestyleImages = unique.filter(url => {
    if (colorImageSet.has(url)) return false;
    const fn = url.split('/').pop().toLowerCase();
    if (bareRe.test(fn)) return false;
    // Skip images that look like other color variants of this collection
    if (fn.startsWith(collLower + '-') || fn.startsWith(collLower.replace(/\s/g, ''))) return false;
    // Prefer descriptive room-scene filenames
    return /bath|kitchen|shower|backsplash|living|bedroom|fireplace|project|cottage|oasis|retreat|elegance|stunning|sleek|modern|classic|install/i.test(fn);
  });

  return { colorImages, lifestyleImages };
}

// ==================== Per-Collection Processing ====================

/**
 * Process a single collection end-to-end:
 *   1. Crawl subseries pages → build colorImageMap + lifestyle list
 *   2. Dedup generic images (shared by 3+ colors)
 *   3. Match color images to SKUs + save
 *   4. Demote B&W outlines
 *   5. Save lifestyle images at product level
 *
 * Returns stats object for aggregation.
 */
async function processCollection(collection, collectionSkus, dryRun) {
  const stats = { subsCount: 0, colorVariants: 0, matched: 0, imagesSaved: 0, noImage: 0, lifestyleSaved: 0 };
  const matchedProductIds = new Set();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${collection.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);

  // ── Step 1: Crawl subseries pages ──
  console.log(`\n  Step 1: Collecting images from subseries pages`);
  const colorImageMap = {};
  const lifestyleImages = [];
  const lifestyleSeen = new Set();

  const collUrl = `${BASE_URL}/series/${collection}/`;
  const collHtml = await fetchPage(collUrl);
  if (!collHtml) {
    console.warn(`  Failed to fetch collection page, skipping`);
    return stats;
  }

  // Determine subseries to visit
  let subseriesToVisit;
  if (collection === 'mosaic') {
    // Mosaic: subseries links are shapes (Penny Rounds, Hex), not colors.
    // Use the actual page links which lead to shape-specific pages.
    const pageSubs = extractSubseries(collHtml);
    if (pageSubs.length > 0) {
      subseriesToVisit = pageSubs;
      console.log(`  Found ${pageSubs.length} shape subseries: ${pageSubs.join(', ')}`);
    } else {
      console.log(`  No subseries links found, skipping`);
      subseriesToVisit = [];
    }
  } else {
    subseriesToVisit = extractSubseries(collHtml);
    console.log(`  Found ${subseriesToVisit.length} subseries: ${subseriesToVisit.join(', ')}`);

    // Fallback: use DB variant_names if no subseries links
    if (subseriesToVisit.length === 0) {
      const variants = new Set();
      for (const row of collectionSkus) {
        if (row.variant_name) variants.add(row.variant_name);
      }
      if (variants.size > 0) {
        subseriesToVisit = [...variants];
        console.log(`  No subseries links; trying ${subseriesToVisit.length} variant_names from DB`);
      }
    }
  }

  // Visit each subseries page
  for (const sub of subseriesToVisit) {
    const subUrl = `${BASE_URL}/series/${collection}/?subserie=${encodeURIComponent(sub)}`;
    const html = await fetchPage(subUrl);
    if (!html) continue;
    stats.subsCount++;

    const result = extractPageImages(html, collection, sub);
    if (result.colorImages.length > 0) {
      colorImageMap[sub.toLowerCase()] = result.colorImages;
      stats.colorVariants++;
      const shortName = result.colorImages[0].split('/').pop();
      console.log(`    ${sub}: ${result.colorImages.length} color + ${result.lifestyleImages.length} lifestyle → ${shortName.slice(-55)}`);
    } else {
      console.log(`    ${sub}: no color images (${result.lifestyleImages.length} lifestyle)`);
    }

    for (const url of result.lifestyleImages) {
      if (!lifestyleSeen.has(url)) {
        lifestyleSeen.add(url);
        lifestyleImages.push(url);
      }
    }
  }

  // ── Step 2: Dedup generic images ──
  const urlCounts = {};
  for (const urls of Object.values(colorImageMap)) {
    const key = urls[0];
    urlCounts[key] = (urlCounts[key] || 0) + 1;
  }
  let removed = 0;
  for (const [color, urls] of Object.entries(colorImageMap)) {
    if (urlCounts[urls[0]] >= 3) {
      delete colorImageMap[color];
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`  Dedup: removed ${removed} entries sharing a generic image`);
    stats.colorVariants -= removed;
  }

  // ── Step 3: Match color images to SKUs ──
  console.log(`  Step 3: Matching images to ${collectionSkus.length} SKUs`);

  for (const row of collectionSkus) {
    const vn = (row.variant_name || '').toLowerCase();
    const colorPart = vn.includes(' - ') ? vn.substring(vn.indexOf(' - ') + 3) : vn;
    const sortedKey = (s) => s.split(/\s+/).sort().join(' ');

    let imageUrls = colorImageMap[vn]
      || colorImageMap[colorPart]
      || Object.entries(colorImageMap).find(([k]) => sortedKey(k) === sortedKey(colorPart))?.[1]
      || null;

    if (!imageUrls) {
      stats.noImage++;
      continue;
    }

    stats.matched++;
    matchedProductIds.add(row.product_id);

    if (dryRun) continue;

    const toSave = imageUrls.slice(0, 4);
    for (let i = 0; i < toSave.length; i++) {
      await upsertMediaAsset(pool, {
        product_id: row.product_id,
        sku_id: row.sku_id,
        asset_type: i === 0 ? 'primary' : 'alternate',
        url: toSave[i],
        original_url: toSave[i],
        sort_order: i,
      });
      stats.imagesSaved++;
    }
  }

  console.log(`  Matched: ${stats.matched} SKUs, ${stats.imagesSaved} images saved, ${stats.noImage} unmatched`);

  // ── Step 4: Demote B&W outlines ──
  if (matchedProductIds.size > 0 && !dryRun) {
    const demoteResult = await pool.query(`
      UPDATE media_assets
      SET asset_type = 'alternate', sort_order = 1
      WHERE product_id = ANY($1)
        AND sku_id IS NULL
        AND asset_type = 'primary'
    `, [[...matchedProductIds]]);
    if (demoteResult.rowCount > 0) {
      console.log(`  Demoted ${demoteResult.rowCount} B&W outline(s) to alternate`);
    }
  }

  // ── Step 5: Save lifestyle images ──
  const productIds = [...new Set(collectionSkus.map(r => r.product_id))];
  if (lifestyleImages.length > 0 && productIds.length > 0) {
    const toSave = lifestyleImages.slice(0, 6);
    console.log(`  Step 5: ${toSave.length} lifestyle image(s) → ${productIds.length} products`);

    if (!dryRun) {
      for (const productId of productIds) {
        for (let i = 0; i < toSave.length; i++) {
          await upsertMediaAsset(pool, {
            product_id: productId,
            sku_id: null,
            asset_type: 'lifestyle',
            url: toSave[i],
            original_url: toSave[i],
            sort_order: 10 + i,
          });
          stats.lifestyleSaved++;
        }
      }
    }
  }

  return stats;
}

// ==================== Main ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetCollection = args.find(a => a !== '--dry-run')?.toLowerCase();

  const collections = targetCollection && targetCollection !== 'all'
    ? [targetCollection]
    : COLLECTIONS;

  if (dryRun) console.log('DRY RUN — no DB writes\n');

  // Load all ADEX SKUs from DB
  const dbResult = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name,
           p.collection, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ADEX' AND s.status = 'active'
  `);
  console.log(`Loaded ${dbResult.rows.length} ADEX SKUs from DB`);

  // Group SKUs by collection
  const skusByCollection = {};
  for (const row of dbResult.rows) {
    const coll = (row.collection || '').toLowerCase();
    if (!skusByCollection[coll]) skusByCollection[coll] = [];
    skusByCollection[coll].push(row);
  }

  // Process each collection end-to-end (avoids OOM from holding all data in memory)
  const totals = { subsCount: 0, colorVariants: 0, matched: 0, imagesSaved: 0, noImage: 0, lifestyleSaved: 0 };

  for (const collection of collections) {
    const collSkus = skusByCollection[collection] || [];
    if (collSkus.length === 0) {
      console.log(`\n  ${collection.toUpperCase()}: no SKUs in DB, skipping`);
      continue;
    }

    const stats = await processCollection(collection, collSkus, dryRun);
    for (const key of Object.keys(totals)) totals[key] += stats[key];
  }

  // ── Summary ──
  console.log('\n=== ADEX Image Scrape Complete ===');
  console.log(`Collections processed:   ${collections.length}`);
  console.log(`Subseries pages crawled: ${totals.subsCount}`);
  console.log(`Color variants found:    ${totals.colorVariants}`);
  console.log(`SKUs matched:            ${totals.matched}`);
  console.log(`Total SKU images saved:  ${totals.imagesSaved}`);
  console.log(`Lifestyle images saved:  ${totals.lifestyleSaved}`);
  console.log(`SKUs with no color match:${totals.noImage}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
