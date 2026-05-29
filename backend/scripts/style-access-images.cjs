#!/usr/bin/env node
/**
 * style-access-images.cjs
 *
 * Scrapes product gallery images from Style Access product pages
 * and matches them to existing products/SKUs in the DB.
 *
 * Phase 1: Fetch product list from WP REST API (slug, title, SKU)
 * Phase 2: Scrape each product page for gallery images (et_pb_gallery_image)
 * Phase 3: Match to DB products, resolve specific SKU, and upsert images
 *
 * Product matching strategy (in priority order):
 *  1. SKU code from WP excerpt → skus.vendor_sku
 *  2. Exact normalized name match
 *  3. Expanded abbreviation match
 *  4. Fuzzy: substring, reversed word order, collection+color
 *  5. Collection-level match (WP title = collection name)
 *
 * SKU matching (after product match):
 *  A. Single-SKU shortcut — if only 1 active SKU, use it
 *  B. Extract variant descriptor from WP title (strip product/collection name)
 *  C. Score by size match + descriptor word overlap
 *  D. Fallback to first (default) SKU
 *
 * Images stored at SKU level (sku_id set):
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

function extractSkuCandidates(excerpt) {
  if (!excerpt) return [];
  const text = excerpt.replace(/<[^>]+>/g, '').trim();
  // Match any alphanumeric token that looks like a vendor SKU code
  // (2+ letters followed by 3+ more alphanumeric chars, e.g. JOLWHTU, CEDRS060017, UTC0324)
  const matches = [...text.matchAll(/\b([A-Z]{2,}[A-Z0-9]{3,})\b/gi)];
  return matches.map(m => m[1].toUpperCase());
}

function getTitle(wpProduct) {
  return decodeHtmlEntities(wpProduct.title?.rendered || '');
}

// ── SKU-level matching ──

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractVariantPart(wpTitle, product) {
  let remainder = wpTitle;
  // Strip collection name first (longer match), then product name
  if (product.collection) {
    const collRe = new RegExp(escapeRegex(product.collection), 'i');
    remainder = remainder.replace(collRe, '');
  }
  const nameRe = new RegExp(escapeRegex(product.name), 'i');
  remainder = remainder.replace(nameRe, '');
  return remainder.replace(/^[\s\-\u2013\u2014:,]+/, '').replace(/[\s\-\u2013\u2014:,]+$/, '').trim();
}

function normalizeDimension(s) {
  return (s || '').toLowerCase()
    .replace(/\u00d7/g, 'x')  // ×
    .replace(/[\u2033\u2032"'\u2034\u2035]/g, '')
    .replace(/\s+/g, '');
}

function extractSize(s) {
  const norm = normalizeDimension(s);
  const m = norm.match(/(\d+\.?\d*)\s*x\s*(\d+\.?\d*)/);
  return m ? `${m[1]}x${m[2]}` : null;
}

function extractDescriptors(s) {
  const norm = (s || '').toLowerCase()
    .replace(/\u00d7/g, 'x')
    .replace(/[\u2033\u2032"'\u2034\u2035]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Remove size patterns to get just descriptor words
  const withoutSize = norm.replace(/\d+\.?\d*\s*x\s*\d+\.?\d*/g, '').trim();
  return withoutSize.split(/\s+/).filter(w => w.length > 1);
}

const DESCRIPTOR_SYNONYMS = {
  'glossy': 'gloss', 'gloss': 'gloss',
  'matte': 'matte', 'mat': 'matte',
  'satin': 'satin',
  'bullnose': 'bullnose', 'bn': 'bullnose',
  'polished': 'polished', 'honed': 'honed',
};

function canonicalDescriptor(word) {
  return DESCRIPTOR_SYNONYMS[word] || word;
}

function findMatchingSku(productId, wpTitle, product, productSkusMap) {
  const skuList = productSkusMap.get(productId);
  if (!skuList || skuList.length === 0) return null;

  // Step A: Single-SKU shortcut
  if (skuList.length === 1) return skuList[0];

  // Step B: Extract variant part from WP title
  const variantPart = extractVariantPart(wpTitle, product);
  if (!variantPart) return skuList[0]; // No variant info -> default to first

  // Step C: Score each SKU
  const wpSize = extractSize(variantPart);
  const wpDescriptors = extractDescriptors(variantPart).map(canonicalDescriptor);

  // Detect if WP title indicates an accessory product
  const wpIsAccessory = /\b(jolly|trim|bullnose)\b/i.test(variantPart);

  let bestSku = null;
  let bestScore = -1;

  for (const sku of skuList) {
    let score = 0;
    const vn = sku.variant_name || '';
    const skuIsAccessory = sku.variant_type === 'accessory' || /\b(jolly|trim|bullnose)\b/i.test(vn);

    // Size matching (strong signal)
    const skuSize = extractSize(vn);
    if (wpSize && skuSize) {
      if (wpSize === skuSize) {
        score += 100;
      } else {
        score -= 50; // Size mismatch is a strong negative
      }
    }

    // Descriptor word overlap
    const skuDescriptors = extractDescriptors(vn).map(canonicalDescriptor);
    for (const wd of wpDescriptors) {
      if (skuDescriptors.includes(wd)) score += 20;
    }
    for (const sd of skuDescriptors) {
      if (wpDescriptors.includes(sd)) score += 20;
    }

    // Bidirectional accessory scoring:
    // If WP title says "Jolly/Trim", boost accessory SKUs and penalize main tiles
    // If WP title is for a main tile, penalize accessory SKUs
    if (wpIsAccessory) {
      score += skuIsAccessory ? 50 : -50;
    } else {
      if (skuIsAccessory) score -= 50;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSku = sku;
    }
  }

  // Step D: Fallback if no confident match
  if (bestScore <= 0) return skuList[0];
  return bestSku;
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

async function upsertImages(productId, skuId, imageUrls, counters) {
  if (!imageUrls.length) return;

  // Delete existing Style Access media_assets for this SKU
  const { rowCount } = await pool.query(
    `DELETE FROM media_assets WHERE sku_id = $1 AND url LIKE '%style-access.com%'`,
    [skuId]
  );
  if (rowCount > 0) counters.deleted += rowCount;

  for (let i = 0; i < imageUrls.length; i++) {
    const assetType = i === 0 ? 'primary' : 'alternate';
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, url, asset_type, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [productId, skuId, imageUrls[i], assetType, i]);
    counters.inserted++;
    if (i === 0) counters.primaries++;
  }
}

async function upsertImagesForCollection(collProducts, imageUrls, counters, productSkusMap) {
  for (const p of collProducts) {
    const skuList = productSkusMap.get(p.id);
    const firstSku = skuList && skuList.length > 0 ? skuList[0] : null;
    if (firstSku) {
      await upsertImages(p.id, firstSku.id, imageUrls, counters);
    }
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
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    ORDER BY s.product_id, s.created_at
  `, [vendorId]);

  // Build lookup maps
  const skuToProduct = new Map();
  for (const s of skus) {
    const raw = s.vendor_sku.replace(/^SA-/, '');
    skuToProduct.set(raw.toUpperCase(), s.product_id);
  }

  // Group SKUs by product (ordered by created_at from the query)
  const productSkus = new Map();
  for (const s of skus) {
    if (!productSkus.has(s.product_id)) productSkus.set(s.product_id, []);
    productSkus.get(s.product_id).push(s);
  }

  // Quick product lookup by ID
  const productById = new Map();
  for (const p of products) productById.set(p.id, p);

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

  // Clean up old product-level (sku_id IS NULL) Style Access images from previous runs
  if (!DRY_RUN) {
    const { rowCount: cleanedUp } = await pool.query(`
      DELETE FROM media_assets
      WHERE sku_id IS NULL
        AND url LIKE '%style-access.com%'
        AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)
    `, [vendorId]);
    if (cleanedUp > 0) {
      console.log(`  Cleaned up ${cleanedUp} old product-level images (migrating to SKU-level)\n`);
    }
  }

  // Phase 1: Fetch WP products
  console.log('Phase 1: Fetching product list from WP API...');
  const wpProducts = await fetchAllWpProducts();
  console.log(`  Fetched ${wpProducts.length} WP products total\n`);

  const counters = { inserted: 0, deleted: 0, primaries: 0 };
  let matched = 0, scraped = 0, skippedNoImages = 0, noMatch = 0, collectionMatches = 0;
  let singleSkuCount = 0, multiSkuCount = 0;
  const unmatchedTitles = [];
  const matchLog = [];
  const productsWithImageAfter = new Set(productsWithImageBefore);

  // Track which SKUs have been assigned images in this run, with match confidence
  // Higher-priority matches won't be overwritten by lower-priority ones
  const assignedSkus = new Map(); // skuId -> { method, priority }
  const METHOD_PRIORITY = { 'sku': 4, 'exact-name': 3, 'expanded-name': 2, 'fuzzy': 1, 'collection': 1 };

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

    // Strategy 1: SKU from excerpt — try all candidates against the DB map
    const skuCandidates = extractSkuCandidates(excerpt);
    let productId = null;
    let matchMethod = null;
    for (const candidate of skuCandidates) {
      const pid = skuToProduct.get(candidate);
      if (pid) {
        productId = pid;
        matchMethod = 'sku';
        break;
      }
    }

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

        if (normTitle.includes(normName) && normName.length > 5) {
          const score = normName.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        if (expTitle.includes(expName) && expName.length > 5) {
          const score = expName.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        if (expName.includes(expTitle) && expTitle.length > 5) {
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
        if (VERBOSE) console.log(`  COLLECTION MATCH: "${title}" -> ${collProducts.length} products`);

        if (!DRY_RUN) {
          await upsertImagesForCollection(collProducts, imageUrls, counters, productSkus);
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

    // Resolve specific SKU for this product
    const matchedProduct = productById.get(productId);
    const matchedSku = matchedProduct
      ? findMatchingSku(productId, title, matchedProduct, productSkus)
      : null;

    if (!matchedSku) {
      if (VERBOSE) console.log(`    WARNING: No active SKU for product ${productId} — skipping images`);
      noMatch++;
      await sleep(DELAY_MS);
      continue;
    }

    // Track single-SKU vs multi-SKU matches
    const skuList = productSkus.get(productId) || [];
    if (skuList.length === 1) {
      singleSkuCount++;
    } else {
      multiSkuCount++;
    }

    matched++;
    if (VERBOSE) {
      matchLog.push({
        title, method: matchMethod, productId,
        skuId: matchedSku.id, skuVariant: matchedSku.variant_name
      });
      console.log(`    -> SKU: ${matchedSku.variant_name || '(default)'} [${matchMethod}]`);
    }

    // Only upsert if no strictly-higher-confidence match already assigned this SKU
    // Same-priority matches CAN overwrite (later, more specific pages win)
    const newPriority = METHOD_PRIORITY[matchMethod] || 0;
    const existingAssignment = assignedSkus.get(matchedSku.id);
    if (existingAssignment && existingAssignment.priority > newPriority) {
      if (VERBOSE) console.log(`    SKIP: SKU ${matchedSku.variant_name} already has ${existingAssignment.method} match (higher priority)`);
    } else {
      if (!DRY_RUN) {
        await upsertImages(productId, matchedSku.id, imageUrls, counters);
      }
      assignedSkus.set(matchedSku.id, { method: matchMethod, priority: newPriority });
      productsWithImageAfter.add(productId);
    }

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
    console.log(`\n  Sibling sharing: ${targetColl} (${targetProducts.length} missing) <- ${sourceColl} (${sourceProducts.length} source)`);

    for (const tp of targetProducts) {
      const sp = sourceProducts.find(s => normalizeForMatch(s.name) === normalizeForMatch(tp.name));
      if (!sp) continue;

      const { rows: srcImages } = await pool.query(
        `SELECT url, asset_type, sort_order FROM media_assets WHERE product_id = $1 ORDER BY sort_order`,
        [sp.id]
      );
      if (!srcImages.length) continue;

      if (VERBOSE) console.log(`    ${tp.name} <- ${sp.name} (${srcImages.length} images)`);

      if (!DRY_RUN) {
        const tpSkuList = productSkus.get(tp.id);
        const tpSku = tpSkuList && tpSkuList.length > 0 ? tpSkuList[0] : null;
        if (tpSku) {
          await upsertImages(tp.id, tpSku.id, srcImages.map(i => i.url), counters);
        }
      }
      productsWithImageAfter.add(tp.id);
    }
  }

  // Report
  console.log(`\n=== Results ===`);
  console.log(`  WP products: ${wpProducts.length}`);
  console.log(`  Pages scraped: ${scraped}`);
  console.log(`  Matched to DB: ${matched} (${collectionMatches} collection-level)`);
  console.log(`  SKU resolution: ${singleSkuCount} single-SKU, ${multiSkuCount} multi-SKU`);
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
      for (const m of byColl) console.log(`    "${m.title}" -> ${m.count} products`);
    }
    const byMethod = {};
    for (const m of byOther) {
      byMethod[m.method] = (byMethod[m.method] || 0) + 1;
    }
    console.log(`  Match method breakdown:`, byMethod);

    // Show SKU-level match details for multi-SKU products
    const multiSkuMatches = byOther.filter(m => m.skuVariant);
    if (multiSkuMatches.length > 0) {
      console.log(`\n  SKU-level matches (sample):`);
      for (const m of multiSkuMatches.slice(0, 30)) {
        console.log(`    "${m.title}" -> SKU: ${m.skuVariant}`);
      }
      if (multiSkuMatches.length > 30) console.log(`    ... and ${multiSkuMatches.length - 30} more`);
    }
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
