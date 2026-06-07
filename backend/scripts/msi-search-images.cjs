#!/usr/bin/env node
/**
 * MSI Search-Based Per-SKU Image Scraper
 *
 * Finds missing MSI SKU images by:
 *   1. Searching msisurfaces.com/site-search/?key={vendor_sku} (SSR, no Puppeteer)
 *   2. Following search results to product detail pages
 *   3. Extracting per-SKU CDN images (matched by vendor_sku in filename)
 *   4. Falling back to product-level primary when no per-SKU match exists
 *   5. Verifying every URL with HEAD before saving
 *
 * All images are saved at SKU level (sku_id IS NOT NULL) for accurate
 * per-variant display in the storefront.
 *
 * CDN patterns discovered (2026-06):
 *   Mosaic:     mosaics/{slug}.jpg                                   (one product = one SKU)
 *   Porcelain:  colornames/{color}-{collection}.jpg                  (product level)
 *               colornames/skus/{color}-{collection}-suk-{sku}.jpg   (per-SKU!)
 *   LVP:        lvt/detail/{collection}-{color}-vinyl-flooring.jpg
 *   Nat. Stone: colornames/{slug}-marble.jpg (or -granite, -quartzite)
 *   Stacked:    hardscaping/detail/{slug}.jpg
 *
 * Usage:
 *   node backend/scripts/msi-search-images.cjs --dry-run
 *   node backend/scripts/msi-search-images.cjs
 *   node backend/scripts/msi-search-images.cjs --category "Mosaic Tile"
 *   node backend/scripts/msi-search-images.cjs --verbose
 *   node backend/scripts/msi-search-images.cjs --replace-generic     # replace /colornames/ images with product-specific ones
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const REPLACE_GENERIC = process.argv.includes('--replace-generic');
const catIdx = process.argv.indexOf('--category');
const CATEGORY_FILTER = catIdx !== -1 ? process.argv[catIdx + 1] : null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const CDN = 'https://cdn.msisurfaces.com/images';
const MSI_BASE = 'https://www.msisurfaces.com';
const DELAY_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function fetchPage(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redir = res.headers.location.startsWith('/')
          ? `${MSI_BASE}${res.headers.location}`
          : res.headers.location;
        res.resume();
        fetchPage(redir, maxRedirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function headUrl(url) {
  return new Promise(resolve => {
    let resolved = false;
    const done = val => { if (!resolved) { resolved = true; resolve(val); } };
    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, res => {
      res.resume();
      done(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Image extraction from SSR HTML
// ─────────────────────────────────────────────────────────────────────────────

/** Junk path segments — never use these as product images */
const JUNK = [
  'svg/', 'miscellaneous/', 'banner', 'trends/', 'roomvo',
  'ss-countertops', 'ss-backsplash', 'ss-flooring', 'ss-hardscape', 'ss-sinks',
  'faucet', 'vanity', 'underlayment', 'adhesive', 'primer',
  'everlife-info', 'multi-use-adhesive', 'concrete-floor',
  'ps_faucets', 'ps_vanity', 'collections/small',
];

function isJunk(path) {
  const lower = path.toLowerCase();
  return JUNK.some(j => lower.includes(j));
}

/**
 * Extract product-level and per-SKU image URLs from an MSI product page HTML.
 *
 * Per-SKU images use the pattern: colornames/skus/{slug}-suk-{VENDOR_SKU}.jpg
 * The vendor_sku in the filename is lowercase, no dashes except those in the
 * original SKU code.
 */
function extractImagesFromPage(html) {
  const productImages = []; // sorted best-first
  const skuImages = new Map(); // VENDOR_SKU_UPPER → url
  if (!html) return { productImages, skuImages };

  const regex = /cdn\.msisurfaces\.com\/images\/([^"'\s>]+\.(?:jpg|png|webp))/gi;
  const seen = new Set();
  let m;

  while ((m = regex.exec(html)) !== null) {
    const path = m[1];
    const fullUrl = `${CDN}/${path}`;
    if (seen.has(fullUrl) || isJunk(path)) continue;
    seen.add(fullUrl);

    const lower = path.toLowerCase();
    // Skip thumbnail duplicates — we prefer full-res
    if (lower.includes('/thumbnails/')) continue;
    // Skip room-scene thumbnails
    if (lower.includes('/roomscenes/thumb/')) continue;
    // Skip video poster images
    if (lower.includes('/videos/') || lower.includes('/lvt-videos/')) continue;

    // Per-SKU detection: "-suk-{vendor_sku}.jpg"
    const sukMatch = lower.match(/-suk-([a-z0-9._-]+?)\.(?:jpg|png|webp)$/);
    if (sukMatch) {
      const skuCode = sukMatch[1].toUpperCase();
      if (!skuImages.has(skuCode)) skuImages.set(skuCode, fullUrl);
      continue;
    }

    productImages.push(fullUrl);
  }

  // Sort product images by quality (best first)
  productImages.sort((a, b) => scoreImage(b) - scoreImage(a));

  return { productImages, skuImages };
}

/** Score an image URL for primary image suitability. Higher = better. */
function scoreImage(url) {
  const l = url.toLowerCase();
  // Root-level product shot (e.g., mosaics/slug.jpg, colornames/slug.jpg)
  if (l.match(/\/(mosaics|colornames|porcelainceramic)\/[^/]+\.jpg$/)) return 100;
  if (l.includes('/detail/') && !l.includes('detail-two')) return 95;
  if (l.includes('/iso/')) return 80;
  if (l.includes('/front/')) return 75;
  if (l.includes('/edge/')) return 60;
  if (l.includes('/detail-two/')) return 55;
  if (l.includes('/variations/')) return 50;
  if (l.includes('/roomscenes/medium/')) return 20;
  if (l.includes('/trims/')) return 10;
  return 40;
}

/**
 * Extract the first product page URL from MSI search results HTML.
 * MSI search uses SSR and returns product links in href attributes.
 */
function extractProductPageUrl(html) {
  if (!html) return null;
  // Product page links follow patterns like /marble/collection/product/
  // or /porcelain-collection/color/ or /luxury-vinyl-xxx/collection/color/
  const regex = /href="(\/(?:marble|porcelain[^"]*|luxury-vinyl[^"]*|hardscap[^"]*|natural-stone[^"]*|backsplash[^"]*|engineered-hardwood[^"]*|lvp[^"]*|lvt[^"]*|flooring[^"]*|stacked-stone[^"]*|mosaic[^"]*|slate[^"]*|granite[^"]*|quartzite[^"]*|sandstone[^"]*|travertine[^"]*)\/)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = m[1];
    // Skip category-only pages (too few path segments)
    const segments = href.split('/').filter(Boolean);
    if (segments.length >= 2) return `${MSI_BASE}${href}`;
  }
  return null;
}

/**
 * Extract search-result thumbnail URLs from MSI search HTML.
 * These are in the HTML as <img src="...cdn.../thumbnails/slug.jpg">
 */
function extractSearchThumbnails(html) {
  if (!html) return [];
  const regex = /cdn\.msisurfaces\.com\/images\/((?:mosaics|colornames|lvt|hardscaping|porcelainceramic)\/thumbnails\/[^"'\s>]+\.(?:jpg|png|webp))/gi;
  const urls = [];
  const seen = new Set();
  let m;
  while ((m = regex.exec(html)) !== null) {
    const full = `${CDN}/${m[1]}`;
    if (!seen.has(full)) { seen.add(full); urls.push(full); }
  }
  return urls;
}

/**
 * Given a thumbnail URL, derive the full-res URL by removing /thumbnails/.
 * e.g., mosaics/thumbnails/slug.jpg → mosaics/slug.jpg
 */
function deriveFullRes(thumbnailUrl) {
  return thumbnailUrl.replace('/thumbnails/', '/');
}

// ─────────────────────────────────────────────────────────────────────────────
// SKU matching logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to find a per-SKU image for a given vendor_sku.
 *
 * Matching strategies (in order):
 *   1. Exact match in skuImages map (from -suk- pattern)
 *   2. Normalized match (strip dashes/dots from both sides)
 *   3. Partial containment match
 */
function findSkuImage(vendorSku, skuImages) {
  if (!vendorSku || skuImages.size === 0) return null;

  const upper = vendorSku.toUpperCase();
  const normalized = upper.replace(/[-_.]/g, '');

  // Exact match
  if (skuImages.has(upper)) return skuImages.get(upper);

  // Normalized match
  for (const [key, url] of skuImages) {
    if (key.replace(/[-_.]/g, '') === normalized) return url;
  }

  // Partial match — vendor_sku might have a suffix like -R11 that the CDN includes
  for (const [key, url] of skuImages) {
    const keyNorm = key.replace(/[-_.]/g, '');
    if (keyNorm.includes(normalized) || normalized.includes(keyNorm)) return url;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMSI Search-Based Per-SKU Image Scraper${DRY_RUN ? ' (DRY RUN)' : ''}${REPLACE_GENERIC ? ' [REPLACE GENERIC]' : ''}`);
  if (CATEGORY_FILTER) console.log(`Category filter: "${CATEGORY_FILTER}"`);
  if (REPLACE_GENERIC) console.log(`Mode: replacing generic /colornames/ images with product-specific ones`);
  console.log('='.repeat(65) + '\n');

  const client = await pool.connect();

  try {
    // 1. Get MSI vendor
    const { rows: [vendor] } = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    if (!vendor) { console.log('ERROR: MSI vendor not found'); return; }

    // 2. Get target MSI SKUs (missing images OR generic /colornames/ images)
    const imageCondition = REPLACE_GENERIC
      ? `AND EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
            AND ma.url LIKE '%/colornames/%' AND ma.url NOT LIKE '%/colornames/skus/%'
        )`
      : `AND NOT EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
        )`;

    const { rows: missingSkus } = await client.query(`
      SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type,
             p.name as product_name, p.display_name, p.collection,
             c.name as category
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1
        AND p.status IN ('active', 'draft') AND s.status = 'active'
        ${imageCondition}
        ${CATEGORY_FILTER ? "AND c.name = $2" : ""}
      ORDER BY c.name, p.name, s.vendor_sku
    `, CATEGORY_FILTER ? [vendor.id, CATEGORY_FILTER] : [vendor.id]);

    const modeLabel = REPLACE_GENERIC ? 'SKUs with generic /colornames/ images' : 'SKUs missing primary images';
    console.log(`Found ${missingSkus.length} ${modeLabel}\n`);
    if (missingSkus.length === 0) { console.log('Nothing to do.'); return; }

    // 3. Group SKUs by product
    const productMap = new Map();
    for (const sku of missingSkus) {
      if (!productMap.has(sku.product_id)) {
        productMap.set(sku.product_id, {
          product_id: sku.product_id,
          name: sku.product_name,
          display_name: sku.display_name,
          collection: sku.collection,
          category: sku.category,
          skus: [],
        });
      }
      productMap.get(sku.product_id).skus.push({
        sku_id: sku.sku_id,
        vendor_sku: sku.vendor_sku,
        variant_name: sku.variant_name,
        variant_type: sku.variant_type,
      });
    }

    console.log(`Across ${productMap.size} products\n`);

    // 4. Process each product
    const inserts = [];
    const stats = {
      products_searched: 0,
      pages_fetched: 0,
      sku_per_sku: 0,
      sku_product_level: 0,
      sku_thumbnail: 0,
      sku_not_found: 0,
      head_ok: 0,
      head_fail: 0,
    };
    const categoryStats = {};

    for (const [productId, product] of productMap) {
      const { name, collection, category, skus } = product;
      if (!categoryStats[category]) {
        categoryStats[category] = { total: 0, perSku: 0, fallback: 0, miss: 0 };
      }
      categoryStats[category].total += skus.length;
      stats.products_searched++;

      // Use the first main SKU's vendor_sku as search term
      const mainSkus = skus.filter(s => s.variant_type !== 'accessory');
      const searchSku = (mainSkus[0] || skus[0]).vendor_sku;

      if (VERBOSE) console.log(`\n─── ${name} [${category}] (${skus.length} SKUs) ───`);

      // ── Step A: Search MSI by vendor_sku ──
      let searchHtml = null;
      let productPageUrl = null;
      let searchThumbnails = [];

      try {
        searchHtml = await fetchPage(`${MSI_BASE}/site-search/?key=${encodeURIComponent(searchSku)}`);
        if (searchHtml) {
          productPageUrl = extractProductPageUrl(searchHtml);
          searchThumbnails = extractSearchThumbnails(searchHtml);
          if (VERBOSE) console.log(`  Search by SKU: page=${productPageUrl ? 'yes' : 'no'}, thumbs=${searchThumbnails.length}`);
        }
      } catch (err) {
        if (VERBOSE) console.log(`  Search error: ${err.message}`);
      }
      await delay(DELAY_MS);

      // If SKU search found nothing, retry with product name
      if (!productPageUrl && searchThumbnails.length === 0) {
        try {
          searchHtml = await fetchPage(`${MSI_BASE}/site-search/?key=${encodeURIComponent(name)}`);
          if (searchHtml) {
            productPageUrl = extractProductPageUrl(searchHtml);
            searchThumbnails = extractSearchThumbnails(searchHtml);
            if (VERBOSE) console.log(`  Search by name: page=${productPageUrl ? 'yes' : 'no'}, thumbs=${searchThumbnails.length}`);
          }
        } catch (err) {
          if (VERBOSE) console.log(`  Name search error: ${err.message}`);
        }
        await delay(DELAY_MS);
      }

      // ── Step B: Fetch product page for gallery + per-SKU images ──
      let pageProductImages = [];
      let pageSkuImages = new Map();

      if (productPageUrl) {
        try {
          const pageHtml = await fetchPage(productPageUrl);
          if (pageHtml) {
            const extracted = extractImagesFromPage(pageHtml);
            pageProductImages = extracted.productImages;
            pageSkuImages = extracted.skuImages;
            stats.pages_fetched++;
            if (VERBOSE) {
              console.log(`  Page: ${pageProductImages.length} product imgs, ${pageSkuImages.size} per-SKU`);
              if (pageSkuImages.size > 0) console.log(`    Per-SKU keys: ${[...pageSkuImages.keys()].join(', ')}`);
            }
          }
        } catch (err) {
          if (VERBOSE) console.log(`  Page error: ${err.message}`);
        }
        await delay(DELAY_MS);
      }

      // In replace-generic mode, exclude generic /colornames/ images from candidates
      // so we only use product-specific images (mosaics/, lvt/detail/, etc.)
      if (REPLACE_GENERIC) {
        const isGeneric = url => {
          const l = url.toLowerCase();
          return l.includes('/colornames/') && !l.includes('/colornames/skus/');
        };
        pageProductImages = pageProductImages.filter(url => !isGeneric(url));
        searchThumbnails = searchThumbnails.filter(url => !isGeneric(url));
      }

      // Best product-level image (sorted by score already)
      const bestProductImg = pageProductImages[0] || null;

      // Full-res versions derived from search thumbnails
      const derivedFullRes = searchThumbnails.map(deriveFullRes);

      // ── Step C: Assign image to each SKU ──
      for (const sku of skus) {
        let imageUrl = null;
        let source = null;

        // Priority 1: Per-SKU image from product page (-suk- pattern)
        const perSkuMatch = findSkuImage(sku.vendor_sku, pageSkuImages);
        if (perSkuMatch) {
          imageUrl = perSkuMatch;
          source = 'per-sku';
        }

        // Priority 2: Best product-level image from product page
        if (!imageUrl && bestProductImg) {
          imageUrl = bestProductImg;
          source = 'product-page';
        }

        // Priority 3: Full-res derived from search thumbnail
        if (!imageUrl && derivedFullRes.length > 0) {
          imageUrl = derivedFullRes[0];
          source = 'derived-thumb';
        }

        // Priority 4: Raw search thumbnail
        if (!imageUrl && searchThumbnails.length > 0) {
          imageUrl = searchThumbnails[0];
          source = 'raw-thumb';
        }

        if (!imageUrl) {
          stats.sku_not_found++;
          categoryStats[category].miss++;
          if (VERBOSE) console.log(`  ✗ ${sku.vendor_sku} — no image found`);
          continue;
        }

        // Verify URL with HEAD
        const verified = await headUrl(imageUrl);
        if (!verified) {
          stats.head_fail++;
          // Try thumbnail fallback if full-res failed
          if (source === 'derived-thumb' && searchThumbnails.length > 0) {
            const thumbOk = await headUrl(searchThumbnails[0]);
            if (thumbOk) {
              imageUrl = searchThumbnails[0];
              source = 'raw-thumb';
              stats.head_ok++;
            } else {
              stats.sku_not_found++;
              categoryStats[category].miss++;
              if (VERBOSE) console.log(`  ✗ ${sku.vendor_sku} — HEAD failed: ${imageUrl}`);
              continue;
            }
          } else {
            stats.sku_not_found++;
            categoryStats[category].miss++;
            if (VERBOSE) console.log(`  ✗ ${sku.vendor_sku} — HEAD failed: ${imageUrl}`);
            continue;
          }
        } else {
          stats.head_ok++;
        }

        // Queue the primary image insert
        inserts.push({
          skuId: sku.sku_id,
          productId: product.product_id,
          url: imageUrl,
          assetType: 'primary',
          sortOrder: 0,
        });

        if (source === 'per-sku') {
          stats.sku_per_sku++;
          categoryStats[category].perSku++;
        } else if (source === 'product-page') {
          stats.sku_product_level++;
          categoryStats[category].fallback++;
        } else {
          stats.sku_thumbnail++;
          categoryStats[category].fallback++;
        }

        if (VERBOSE) {
          const short = imageUrl.replace('https://cdn.msisurfaces.com/images/', '');
          console.log(`  ✓ ${sku.vendor_sku} ← ${source}: ${short}`);
        }
      }

      // ── Step D: Add alternate images (iso, edge, detail-two) for matched SKUs ──
      if (pageProductImages.length > 1) {
        const altCandidates = pageProductImages.slice(1).filter(url => {
          const l = url.toLowerCase();
          return !l.includes('/roomscenes/') && !l.includes('/trims/');
        }).slice(0, 3); // max 3 alternates

        for (const sku of skus) {
          const hasPrimary = inserts.some(i => i.skuId === sku.sku_id && i.assetType === 'primary');
          if (!hasPrimary) continue;
          const primaryUrl = inserts.find(i => i.skuId === sku.sku_id && i.assetType === 'primary')?.url;

          let sortIdx = 0;
          for (const altUrl of altCandidates) {
            if (altUrl === primaryUrl) continue;
            sortIdx++;
            inserts.push({
              skuId: sku.sku_id,
              productId: product.product_id,
              url: altUrl,
              assetType: 'alternate',
              sortOrder: sortIdx,
            });
          }
        }
      }
    }

    // ── Summary ──
    const primaryInserts = inserts.filter(i => i.assetType === 'primary');
    const altInserts = inserts.filter(i => i.assetType !== 'primary');

    console.log(`\n${'='.repeat(65)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  Products searched:          ${stats.products_searched}`);
    console.log(`  Product pages fetched:      ${stats.pages_fetched}`);
    console.log(`  SKUs matched (per-SKU):     ${stats.sku_per_sku}`);
    console.log(`  SKUs matched (product img): ${stats.sku_product_level}`);
    console.log(`  SKUs matched (thumbnail):   ${stats.sku_thumbnail}`);
    console.log(`  SKUs not found:             ${stats.sku_not_found}`);
    console.log(`  HEAD verified:              ${stats.head_ok}`);
    console.log(`  HEAD failed:                ${stats.head_fail}`);
    console.log(`  Primary inserts:            ${primaryInserts.length}`);
    console.log(`  Alternate inserts:          ${altInserts.length}`);

    console.log(`\nPer-category:`);
    for (const [cat, cs] of Object.entries(categoryStats).sort((a, b) => b[1].total - a[1].total)) {
      const found = cs.perSku + cs.fallback;
      const pct = cs.total > 0 ? (100 * found / cs.total).toFixed(1) : '0.0';
      console.log(`  ${cat.padEnd(24)} ${String(cs.total).padStart(3)} SKUs → ${String(found).padStart(3)} found (${pct.padStart(5)}%) [per-sku:${cs.perSku} fallback:${cs.fallback} miss:${cs.miss}]`);
    }

    if (primaryInserts.length === 0) {
      console.log('\nNo new images to insert.');
      return;
    }

    console.log(`\nSample inserts (first 25):`);
    for (const ins of primaryInserts.slice(0, 25)) {
      const short = ins.url.replace('https://cdn.msisurfaces.com/images/', '');
      console.log(`  ${ins.skuId.slice(0, 8)}… → ${short}`);
    }

    if (DRY_RUN) {
      console.log(`\nDry run — no changes made.`);
      return;
    }

    // ── Insert ──
    console.log(`\nInserting ${inserts.length} media_assets...`);
    await client.query('BEGIN');

    let inserted = 0, errors = 0;
    for (const ins of inserts) {
      try {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $4, $5)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [ins.productId, ins.skuId, ins.assetType, ins.url, ins.sortOrder]);
        inserted++;
      } catch (err) {
        errors++;
        if (VERBOSE) console.log(`  Insert error: ${err.message}`);
      }
    }

    await client.query('COMMIT');
    console.log(`Inserted ${inserted} (${errors} errors).`);

    // ── Final coverage ──
    const { rows: [final] } = await client.query(`
      SELECT
        COUNT(DISTINCT s.id) as total,
        COUNT(DISTINCT s.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
        )) as covered
      FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.status IN ('active', 'draft') AND s.status = 'active'
    `, [vendor.id]);

    console.log(`\nFinal MSI SKU coverage: ${final.covered}/${final.total} (${(100 * final.covered / final.total).toFixed(1)}%)`);

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\nFATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
