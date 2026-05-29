#!/usr/bin/env node
/**
 * style-access-images.cjs
 *
 * Scrapes product gallery images from Style Access product pages
 * and matches them to existing products in the DB.
 *
 * Phase 1: Fetch product list from WP REST API (slug, title, SKU)
 * Phase 2: Scrape each product page for gallery images (et_pb_gallery_image)
 * Phase 3: Match to DB products and upsert images in slider order
 *
 * Matching strategy (in priority order):
 *  1. SKU code from WP excerpt → skus.vendor_sku
 *  2. Exact normalized name match
 *  3. Expanded abbreviation match
 *  4. Fuzzy: substring, reversed word order, collection+color
 *  5. Collection-level match (WP title = collection name)
 *
 * Images stored at product level (sku_id = NULL):
 *  - First gallery image → asset_type: 'primary', sort_order: 0
 *  - Subsequent images → asset_type: 'alternate', sort_order: 1, 2, ...
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const VENDOR_CODE = 'STYLEACCESS';
const WP_API = 'https://style-access.com/wp-json/wp/v2/product';
const PER_PAGE = 100;

const DELAY_MS = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// HTML entity decoding
function decodeHtmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#8243;/g, '"')
    .replace(/&#8242;/g, "'")
    .replace(/&#215;/g, '×')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// Abbreviation expansions for fuzzy matching
const ABBREVS = {
  'hex': 'hexagon',
  'herr': 'herringbone',
  'chev': 'chevron',
  'penny': 'pennyround',
  'penny round': 'pennyround',
  'disks': 'discs',
  '125': '1 25',
};

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function expandAbbrevs(s) {
  let n = normalizeForMatch(s);
  const shapeWords = 'hexagon|hex|discs?|disks?|bars?|penny\\s*round|pennyround|mosaic|chevron|herringbone|bevel|linear|spackle|lantern|concave|bullnose';
  n = n.replace(new RegExp(`(\\b\\d+\\s+)+(${shapeWords})\\b`, 'g'), '$2');
  for (const [abbr, full] of Object.entries(ABBREVS)) {
    n = n.replace(new RegExp(`\\b${abbr}\\b`, 'g'), full);
  }
  n = n.replace(/\s+(mosaic|unglazed|matte|polished|honed)\s*$/g, '');
  n = n.replace(/\s+2cm\b/g, '');
  return n.replace(/\s+/g, ' ').trim();
}

function extractSkuFromExcerpt(excerpt) {
  if (!excerpt) return null;
  const text = excerpt.replace(/<[^>]+>/g, '').trim();
  const m = text.match(/\b(CT[A-Z0-9]{4,}|CE[A-Z0-9]{4,}|LG[A-Z0-9]{4,})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function getTitle(wpProduct) {
  return decodeHtmlEntities(wpProduct.title?.rendered || '');
}

// ── Phase 1: Fetch product list from WP REST API ──

async function fetchAllWpProducts() {
  const allProducts = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${WP_API}?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  API error on page ${page}: ${res.status}`);
      break;
    }
    totalPages = parseInt(res.headers.get('x-wp-totalpages') || '1', 10);
    const products = await res.json();
    allProducts.push(...products);
    console.log(`  Fetched page ${page}/${totalPages} (${products.length} products)`);
    page++;
    if (page <= totalPages) await sleep(DELAY_MS);
  }
  return allProducts;
}

// ── Phase 2: Scrape product page for gallery images ──

async function scrapeGalleryImages(slug) {
  const pageUrl = `https://style-access.com/product/${slug}/`;
  try {
    const res = await fetch(pageUrl);
    if (!res.ok) {
      if (VERBOSE) console.log(`    Page ${res.status}: ${pageUrl}`);
      return [];
    }
    const html = await res.text();

    // Extract full-size image URLs from et_pb_gallery_image <a href="..."> in DOM order
    const urls = [];
    const galleryRegex = /et_pb_gallery_image[^>]*>[\s\S]*?<a\s+href="([^"]+)"/g;
    let match;
    while ((match = galleryRegex.exec(html)) !== null) {
      const href = match[1];
      if (href && /\.(jpe?g|png|webp)/i.test(href)) {
        urls.push(href);
      }
    }

    // Deduplicate while preserving order
    const seen = new Set();
    return urls.filter(u => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  } catch (err) {
    if (VERBOSE) console.log(`    Fetch error for ${slug}: ${err.message}`);
    return [];
  }
}

// ── Phase 3: Match & upsert ──

async function upsertImages(productId, imageUrls, counters) {
  if (!imageUrls.length) return;

  // Delete existing Style Access media_assets for this product
  const { rowCount } = await pool.query(
    `DELETE FROM media_assets WHERE product_id = $1 AND url LIKE '%style-access.com%'`,
    [productId]
  );
  if (rowCount > 0) counters.deleted += rowCount;

  for (let i = 0; i < imageUrls.length; i++) {
    const assetType = i === 0 ? 'primary' : 'alternate';
    await pool.query(`
      INSERT INTO media_assets (product_id, url, asset_type, sort_order)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [productId, imageUrls[i], assetType, i]);
    counters.inserted++;
    if (i === 0) counters.primaries++;
  }
}

async function upsertImagesForProducts(productIds, imageUrls, counters) {
  for (const pid of productIds) {
    await upsertImages(pid, imageUrls, counters);
  }
}

async function main() {
  console.log(`\n=== Style Access Image Scraper (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  // Load DB data
  const { rows: vendor } = await pool.query(`SELECT id FROM vendors WHERE code = $1`, [VENDOR_CODE]);
  if (!vendor.length) { console.error('Vendor not found'); process.exit(1); }
  const vendorId = vendor[0].id;

  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.collection, p.display_name
    FROM products p
    WHERE p.vendor_id = $1 AND p.is_active = true
  `, [vendorId]);

  const { rows: skus } = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  // Build lookup maps
  const skuToProduct = new Map();
  for (const s of skus) {
    const raw = s.vendor_sku.replace(/^SA-/, '');
    skuToProduct.set(raw.toUpperCase(), s.product_id);
  }

  const nameToProduct = new Map();
  for (const p of products) {
    nameToProduct.set(normalizeForMatch(p.name), p);
    if (p.collection && p.name !== p.collection) {
      nameToProduct.set(normalizeForMatch(`${p.collection} ${p.name}`), p);
    }
  }

  const collectionToProducts = new Map();
  for (const p of products) {
    if (!p.collection) continue;
    const key = normalizeForMatch(p.collection);
    if (!collectionToProducts.has(key)) collectionToProducts.set(key, []);
    collectionToProducts.get(key).push(p);
  }

  const expandedNameToProduct = new Map();
  for (const p of products) {
    expandedNameToProduct.set(expandAbbrevs(p.name), p);
    if (p.collection && p.name !== p.collection) {
      expandedNameToProduct.set(expandAbbrevs(`${p.collection} ${p.name}`), p);
    }
  }

  // Count existing images before
  const { rows: existingImages } = await pool.query(`
    SELECT product_id, url FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1
  `, [vendorId]);
  const productsWithImageBefore = new Set(existingImages.map(i => i.product_id));

  console.log(`  DB: ${products.length} products, ${skus.length} SKUs`);
  console.log(`  DB: ${productsWithImageBefore.size} products have images`);
  console.log(`  DB: ${existingImages.length} existing image rows\n`);

  // Phase 1: Fetch WP products
  console.log('Phase 1: Fetching product list from WP API...');
  const wpProducts = await fetchAllWpProducts();
  console.log(`  Fetched ${wpProducts.length} WP products total\n`);

  const counters = { inserted: 0, deleted: 0, primaries: 0 };
  let matched = 0, scraped = 0, skippedNoImages = 0, noMatch = 0, collectionMatches = 0;
  const unmatchedTitles = [];
  const matchLog = [];
  const productsWithImageAfter = new Set(productsWithImageBefore);

  // Phase 2 & 3: Scrape each product page and match
  console.log('Phase 2-3: Scraping product pages and matching...\n');

  for (let idx = 0; idx < wpProducts.length; idx++) {
    const wp = wpProducts[idx];
    const title = getTitle(wp);
    const excerpt = wp.excerpt?.rendered || '';
    const slug = wp.slug;

    // Progress indicator
    if ((idx + 1) % 50 === 0 || idx === wpProducts.length - 1) {
      console.log(`  Progress: ${idx + 1}/${wpProducts.length} (matched: ${matched}, no-match: ${noMatch})`);
    }

    // Scrape the product page for gallery images
    const imageUrls = await scrapeGalleryImages(slug);
    scraped++;

    if (imageUrls.length === 0) {
      skippedNoImages++;
      if (VERBOSE) console.log(`  No gallery images: "${title}" (${slug})`);
      continue;
    }

    if (VERBOSE) console.log(`  ${imageUrls.length} images: "${title}" (${slug})`);

    // ── Matching strategies ──

    // Strategy 1: SKU from excerpt
    const sku = extractSkuFromExcerpt(excerpt);
    let productId = sku ? skuToProduct.get(sku) : null;
    let matchMethod = productId ? 'sku' : null;

    // Strategy 2: Exact name match
    if (!productId) {
      const normTitle = normalizeForMatch(title);
      const product = nameToProduct.get(normTitle);
      if (product) { productId = product.id; matchMethod = 'exact-name'; }
    }

    // Strategy 3: Expanded abbreviation match
    if (!productId) {
      const expTitle = expandAbbrevs(title);
      const product = expandedNameToProduct.get(expTitle);
      if (product) { productId = product.id; matchMethod = 'expanded-name'; }
    }

    // Strategy 4: Fuzzy matching
    if (!productId) {
      const normTitle = normalizeForMatch(title);
      const expTitle = expandAbbrevs(title);
      const titleWords = normTitle.replace(/\b(in|of|and|the|with)\b/g, '').replace(/\s+/g, ' ').trim().split(' ');
      const titleWordSet = new Set(titleWords.filter(w => w.length > 2));

      let bestMatch = null;
      let bestScore = 0;

      for (const p of products) {
        const normName = normalizeForMatch(p.name);
        const expName = expandAbbrevs(p.name);

        if (normTitle.includes(normName) && normName.length > 3) {
          const score = normName.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        if (expTitle.includes(expName) && expName.length > 3) {
          const score = expName.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        if (expName.includes(expTitle) && expTitle.length > 3) {
          const score = expTitle.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        const nameWords = normName.replace(/\b(in|of|and|the|with)\b/g, '').replace(/\s+/g, ' ').trim().split(' ');
        if (nameWords.length >= 2 && titleWordSet.size >= 2) {
          const nameWordSet = new Set(nameWords.filter(w => w.length > 2));
          const titleInName = [...titleWordSet].every(w => nameWordSet.has(w));
          const nameInTitle = [...nameWordSet].every(w => titleWordSet.has(w));
          if ((titleInName || nameInTitle) && Math.min(titleWordSet.size, nameWordSet.size) >= 2) {
            const score = (titleWordSet.size + nameWordSet.size) * 50;
            if (score > bestScore) { bestMatch = p; bestScore = score; }
          }
        }

        const normColl = normalizeForMatch(p.collection || '');
        if (normColl && normTitle.includes(normColl)) {
          const colorPart = normName.replace(normColl, '').trim();
          if (colorPart && normTitle.includes(colorPart)) {
            const score = (normColl.length + colorPart.length) * 10;
            if (score > bestScore) { bestMatch = p; bestScore = score; }
          }
        }
      }

      if (bestMatch) {
        productId = bestMatch.id;
        matchMethod = 'fuzzy';
      }
    }

    // Strategy 5: Collection-level match
    if (!productId) {
      const normTitle = normalizeForMatch(title);
      const collProducts = collectionToProducts.get(normTitle);
      if (collProducts && collProducts.length > 0) {
        collectionMatches++;
        if (VERBOSE) console.log(`  COLLECTION MATCH: "${title}" → ${collProducts.length} products`);

        if (!DRY_RUN) {
          await upsertImagesForProducts(collProducts.map(p => p.id), imageUrls, counters);
        }
        for (const p of collProducts) productsWithImageAfter.add(p.id);
        matched++;
        matchLog.push({ title, method: 'collection', count: collProducts.length });
        await sleep(DELAY_MS);
        continue;
      }
    }

    if (!productId) {
      noMatch++;
      unmatchedTitles.push(title);
      await sleep(DELAY_MS);
      continue;
    }

    matched++;
    if (VERBOSE) matchLog.push({ title, method: matchMethod, productId });

    if (!DRY_RUN) {
      await upsertImages(productId, imageUrls, counters);
    }
    productsWithImageAfter.add(productId);

    await sleep(DELAY_MS);
  }

  // Sibling collection sharing for products still missing images
  const SIBLING_COLLECTIONS = {
    'Multiforma': 'Linea',
  };

  for (const [targetColl, sourceColl] of Object.entries(SIBLING_COLLECTIONS)) {
    const targetProducts = products.filter(p => p.collection === targetColl && !productsWithImageAfter.has(p.id));
    if (!targetProducts.length) continue;

    const sourceProducts = products.filter(p => p.collection === sourceColl);
    console.log(`\n  Sibling sharing: ${targetColl} (${targetProducts.length} missing) ← ${sourceColl} (${sourceProducts.length} source)`);

    for (const tp of targetProducts) {
      const sp = sourceProducts.find(s => normalizeForMatch(s.name) === normalizeForMatch(tp.name));
      if (!sp) continue;

      const { rows: srcImages } = await pool.query(
        `SELECT url, asset_type, sort_order FROM media_assets WHERE product_id = $1 ORDER BY sort_order`,
        [sp.id]
      );
      if (!srcImages.length) continue;

      if (VERBOSE) console.log(`    ${tp.name} ← ${sp.name} (${srcImages.length} images)`);

      if (!DRY_RUN) {
        await upsertImages(tp.id, srcImages.map(i => i.url), counters);
      }
      productsWithImageAfter.add(tp.id);
    }
  }

  // Report
  console.log(`\n=== Results ===`);
  console.log(`  WP products: ${wpProducts.length}`);
  console.log(`  Pages scraped: ${scraped}`);
  console.log(`  Matched to DB: ${matched} (${collectionMatches} collection-level)`);
  console.log(`  No match: ${noMatch}`);
  console.log(`  Skipped (no gallery images): ${skippedNoImages}`);
  console.log(`  Images deleted (old): ${counters.deleted}`);
  console.log(`  Images inserted (new): ${counters.inserted}`);
  console.log(`  New primaries: ${counters.primaries}`);
  console.log(`  Products with images (before): ${productsWithImageBefore.size}`);
  console.log(`  Products with images (after): ${productsWithImageAfter.size}`);

  const stillMissing = products.filter(p => !productsWithImageAfter.has(p.id));
  console.log(`  Still missing images: ${stillMissing.length}`);

  if (stillMissing.length > 0) {
    console.log(`\n  --- Products still missing images ---`);
    for (const p of stillMissing) {
      console.log(`    [${p.collection || 'no-collection'}] "${p.name}"`);
    }
  }

  if (VERBOSE && matchLog.length > 0) {
    console.log(`\n  --- Match log ---`);
    const byColl = matchLog.filter(m => m.method === 'collection');
    const byOther = matchLog.filter(m => m.method !== 'collection');
    if (byColl.length) {
      console.log(`  Collection-level matches:`);
      for (const m of byColl) console.log(`    "${m.title}" → ${m.count} products`);
    }
    const byMethod = {};
    for (const m of byOther) {
      byMethod[m.method] = (byMethod[m.method] || 0) + 1;
    }
    console.log(`  Match method breakdown:`, byMethod);
  }

  if (unmatchedTitles.length > 0) {
    console.log(`\n  --- Unmatched WP titles (sample) ---`);
    for (const t of unmatchedTitles.slice(0, 30)) {
      console.log(`    "${t}"`);
    }
    if (unmatchedTitles.length > 30) console.log(`    ... and ${unmatchedTitles.length - 30} more`);
  }

  if (DRY_RUN) {
    console.log(`\n  DRY RUN — no changes made.\n`);
  }

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
