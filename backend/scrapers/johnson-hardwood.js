/**
 * Johnson Hardwood — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * johnsonhardwood.com (WordPress) to capture product images from
 * series listing pages and individual product detail pages.
 *
 * URL patterns:
 *   Series pages:  /series/[series-slug]/
 *   Product pages: /products/[sku-lowercase]-[color-slug]/
 *
 * Approach:
 *   1. Visit each series page → extract product cards with links & thumbnails
 *   2. Match cards to DB products via SKU code found in card text
 *   3. Visit each product detail page → extract gallery images
 *   4. Save images to media_assets
 *
 * Usage: docker compose exec api node scrapers/johnson-hardwood.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, upsertMediaAsset,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://johnsonhardwood.com';

// Series slug mappings — collection name → website URL slug
const SERIES_SLUGS = {
  'Alehouse':        'alehouse',
  'English Pub':     'english-pub',
  'Grand Chateau':   'grand-chateau',
  'Oak Grove':       'oak-grove',
  'Tuscan':          'tuscan',
  'Canyon Ridge':    'canyon-ridge-series',
  'Countryside Oak': 'countryside-oak',
  'Olympus':         'olympus-series',
  'Texas Timber':    'texas-timber',
  'Cellar House':    'cellar-house',
  'Farmhouse Manor': 'farmhouse-manor',
  'Public House':    'public-house',
  'Sicily':          'sicily',
  'Skyview':         'skyview',
  'Bella Vista':     'bella-vista',
  'Olde Tavern':     'olde-tavern',
};

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    const distance = 400;
    const delay = 250;
    const height = document.body.scrollHeight;
    for (let pos = 0; pos < height; pos += distance) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, delay));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

// Extract product cards from a series listing page
async function extractSeriesCards(page, seriesUrl) {
  try {
    const resp = await page.goto(seriesUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp ? resp.status() : 'no response'}`);
      return [];
    }
    await delay(1500);
    await scrollToLoadAll(page);

    return page.evaluate(() => {
      const cards = [];
      const seen = new Set();

      // Find all product links — extract SKU from URL slug
      // URL pattern: /products/ame-ahm19001-maibock/
      const allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (const a of allLinks) {
        if (!a.href || seen.has(a.href)) continue;
        seen.add(a.href);

        // Parse SKU and color from URL slug
        const match = a.href.match(/\/products\/([^/]+)\/?$/);
        if (!match) continue;
        const slug = match[1]; // e.g. "ame-ahm19001-maibock"

        // Find the nearest img (might be inside or adjacent)
        const img = a.querySelector('img') || a.parentElement?.querySelector('img');
        let thumbUrl = img ? (img.src || img.getAttribute('data-src') || '') : '';

        // Try to get text content for color name
        let colorName = '';
        const allText = a.textContent.trim();
        // Remove "Color" prefix if present
        const cleaned = allText.replace(/^Color\s*/i, '').trim();
        // Take first line as color name (before SKU code)
        const lines = cleaned.split(/\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          colorName = lines[0];
        }

        cards.push({
          href: a.href,
          slug,
          colorName,
          thumbnail: thumbUrl,
        });
      }

      return cards;
    });
  } catch (err) {
    console.log(`    Error loading series: ${err.message}`);
    return [];
  }
}

// Extract gallery images from a product detail page
async function extractDetailImages(page, productUrl) {
  try {
    const resp = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) return [];
    await delay(2000);
    await scrollToLoadAll(page);

    return page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // All images on the page from wp-content/uploads
      const allImgs = document.querySelectorAll('img');
      for (const img of allImgs) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (!src || !src.includes('/wp-content/uploads/')) continue;
        if (src.includes('logo') || src.includes('icon') || src.includes('favicon') ||
            src.includes('banner') || src.includes('pdf-icon') || src.includes('arrow')) continue;

        // Skip tiny images (likely icons/bullets)
        const w = img.naturalWidth || img.width || 0;
        if (w > 0 && w < 50) continue;

        if (!seen.has(src)) {
          seen.add(src);
          imgs.push({ src, alt: img.alt || '' });
        }
      }

      // Also check gallery link hrefs for full-size originals
      const galleryLinks = document.querySelectorAll('a[href*="/wp-content/uploads/"]');
      for (const a of galleryLinks) {
        const href = a.href || '';
        if (href && !seen.has(href) && !href.includes('logo') && !href.includes('.pdf')) {
          seen.add(href);
          imgs.push({ src: href, alt: '' });
        }
      }

      return imgs;
    });
  } catch (err) {
    console.log(`      Error loading detail: ${err.message}`);
    return [];
  }
}

// Get full-size URL from a WordPress thumbnail URL
function getFullSizeUrl(url) {
  // Remove -WIDTHxHEIGHT suffix before extension
  return url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'JOHNSONHW'");
  if (!vendorRes.rows.length) { console.error('Johnson Hardwood vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all SKUs for this vendor
  const skuRows = await pool.query(`
    SELECT p.id as product_id, p.name as product_name, p.collection,
           s.id as sku_id, s.internal_sku, s.vendor_sku, s.variant_name
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Found ${skuRows.rowCount} SKUs to enrich with images\n`);

  // Build lookups
  const skusByVendorCode = new Map();  // vendor_sku → row
  const productsByName = new Map();     // normalized name → [rows]

  for (const row of skuRows.rows) {
    if (row.vendor_sku) {
      skusByVendorCode.set(row.vendor_sku.toUpperCase(), row);
    }
    const key = normalizeName(row.product_name);
    if (!productsByName.has(key)) productsByName.set(key, []);
    productsByName.get(key).push(row);
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  const matchedProducts = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    for (const [collection, slug] of Object.entries(SERIES_SLUGS)) {
      const seriesUrl = `${BASE_URL}/series/${slug}/`;
      console.log(`\n=== ${collection} — ${seriesUrl} ===`);

      const cards = await extractSeriesCards(page, seriesUrl);
      console.log(`  Found ${cards.length} product cards`);

      if (cards.length === 0) continue;

      for (const card of cards) {
        // Try to extract SKU code from URL slug
        // Slug patterns: "ame-ahm19001-maibock", "cellar-18201-barbera", "bvs-19401-monza"
        // "3ws-46801-messina", "pl-olh30001-athena"
        let skuFromUrl = '';
        const slug = card.slug || '';

        // Try known SKU patterns in the slug
        // AME-AHM19001 → slug has "ame-ahm19001"
        // CELLAR-18201 → slug has "cellar-18201"
        // BVS-19401 → slug has "bvs-19401"
        // 3WS-46801 → slug has "3ws-46801"
        // PL-OLH30001 → slug has "pl-olh30001"
        // FM-18201 → slug has "fm-18201"
        // PHS-17801 → slug has "phs-17801"
        // SV-22301 → slug has "sv-22301"
        // OTS-16501 → slug has "ots-16501"
        for (const [vendorSku] of skusByVendorCode) {
          const skuSlug = vendorSku.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (slug.startsWith(skuSlug)) {
            skuFromUrl = vendorSku;
            break;
          }
        }

        let matched = null;
        if (skuFromUrl) {
          matched = skusByVendorCode.get(skuFromUrl);
        }

        // Fallback: extract color from URL slug and match within collection
        // e.g. "texas-timber-series-alabaster" → "alabaster"
        if (!matched) {
          // Get the last segment of the slug as color guess
          const slugParts = slug.split('-');
          const colorFromSlug = slugParts[slugParts.length - 1];

          if (colorFromSlug && colorFromSlug.length >= 3) {
            for (const [key, rows] of productsByName.entries()) {
              if (rows[0].collection !== collection) continue;
              if (key.endsWith(colorFromSlug) || key.includes(colorFromSlug)) {
                matched = rows[0];
                break;
              }
            }
          }
        }

        // Fallback: match by card color name within this collection
        if (!matched && card.colorName) {
          const colorNorm = normalizeName(card.colorName);
          // Skip generic labels like "see it in my room"
          if (colorNorm && !colorNorm.includes('see it') && !colorNorm.includes('gallery')) {
            for (const [key, rows] of productsByName.entries()) {
              if (rows[0].collection === collection && key.includes(colorNorm)) {
                matched = rows[0];
                break;
              }
            }
            if (!matched) {
              for (const [key, rows] of productsByName.entries()) {
                if (rows[0].collection === collection && colorNorm.includes(key)) {
                  matched = rows[0];
                  break;
                }
              }
            }
            if (!matched) {
              for (const [key, rows] of productsByName.entries()) {
                if (rows[0].collection !== collection) continue;
                const productWords = key.split(' ');
                const lastWord = productWords[productWords.length - 1];
                if (lastWord.length >= 3 && colorNorm.includes(lastWord)) {
                  matched = rows[0];
                  break;
                }
              }
            }
          }
        }

        if (!matched) {
          console.log(`  [SKIP] No match for: slug="${slug}" color="${card.colorName}"`);
          continue;
        }

        if (matchedProducts.has(matched.product_id)) continue;
        matchedProducts.add(matched.product_id);

        console.log(`  [MATCH] ${card.colorName} → ${matched.product_name}`);

        // Visit detail page for gallery images
        const detailImages = await extractDetailImages(page, card.href);

        // Build image URL list, preferring full-size versions
        const allImageUrls = [];
        const seenUrls = new Set();

        for (const img of detailImages) {
          const fullUrl = getFullSizeUrl(img.src);
          if (!seenUrls.has(fullUrl)) {
            seenUrls.add(fullUrl);
            allImageUrls.push(fullUrl);
          }
          // Also add the original (sized) version as fallback
          if (!seenUrls.has(img.src)) {
            seenUrls.add(img.src);
            // Don't add sized versions if we already have the full-size
          }
        }

        // Add thumbnail from series page as fallback
        if (card.thumbnail && card.thumbnail.includes('/wp-content/uploads/')) {
          const fullThumb = getFullSizeUrl(card.thumbnail);
          if (!seenUrls.has(fullThumb)) {
            allImageUrls.push(fullThumb);
          }
        }

        if (allImageUrls.length === 0) {
          console.log(`    No images found`);
          continue;
        }

        // Save images
        const toSave = allImageUrls.slice(0, 6);
        for (let i = 0; i < toSave.length; i++) {
          const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
          await upsertMediaAsset(pool, {
            product_id: matched.product_id,
            sku_id: matched.sku_id,
            asset_type: assetType,
            url: toSave[i],
            original_url: toSave[i],
            sort_order: i,
          });
          imagesSaved++;
        }

        productsMatched++;
        console.log(`    Saved ${toSave.length} image(s)`);

        await delay(600);
      }
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${productsByName.size}`);
    console.log(`Total images saved: ${imagesSaved}`);
    console.log(`Coverage: ${(productsMatched / productsByName.size * 100).toFixed(1)}%`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
