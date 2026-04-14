#!/usr/bin/env node
/**
 * style-access-images.cjs
 *
 * Fetches product images from Style Access WooCommerce REST API
 * and matches them to existing products in the DB by SKU code + name.
 *
 * Matching strategy (in priority order):
 *  1. SKU code from WP excerpt → skus.vendor_sku
 *  2. Exact normalized name match
 *  3. Collection-level match (WP title = collection name → all products in collection)
 *  4. Fuzzy: WP title contains product name or vice versa
 *  5. Abbreviation-expanded fuzzy match
 *
 * Primary = product silo/detail shot (typically the featured image)
 * Alternate = room scene or additional images from product gallery
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
    .replace(/&#8243;/g, '"')   // right double quotation / inch mark
    .replace(/&#8242;/g, "'")   // prime / foot mark
    .replace(/&#215;/g, '×')    // multiplication sign
    .replace(/&#8211;/g, '–')   // en dash
    .replace(/&#8217;/g, "'")   // right single quotation
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/<[^>]+>/g, '')    // strip remaining HTML tags
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
  // Strip all numeric size specs (e.g., "1 25", "3", "1 6", "3 6", "24 48") before shape words
  // This handles "1.25" Discs" → "1 25 discs" → "discs" and "1×6 Bars" → "1 6 bars" → "bars"
  const shapeWords = 'hexagon|hex|discs?|disks?|bars?|penny\\s*round|pennyround|mosaic|chevron|herringbone|bevel|linear|spackle|lantern|concave|bullnose';
  n = n.replace(new RegExp(`(\\b\\d+\\s+)+(${shapeWords})\\b`, 'g'), '$2');
  // Expand abbreviations
  for (const [abbr, full] of Object.entries(ABBREVS)) {
    n = n.replace(new RegExp(`\\b${abbr}\\b`, 'g'), full);
  }
  // Remove trailing "mosaic", "unglazed" for better matching
  n = n.replace(/\s+(mosaic|unglazed|matte|polished|honed)\s*$/g, '');
  // Strip "2cm" outdoor thickness marker
  n = n.replace(/\s+2cm\b/g, '');
  return n.replace(/\s+/g, ' ').trim();
}

async function fetchAllWpProducts() {
  const allProducts = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${WP_API}?per_page=${PER_PAGE}&page=${page}&_embed`;
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

function extractSkuFromExcerpt(excerpt) {
  if (!excerpt) return null;
  const text = excerpt.replace(/<[^>]+>/g, '').trim();
  // SKU patterns: CT/CE/LG prefix + alphanumeric
  const m = text.match(/\b(CT[A-Z0-9]{4,}|CE[A-Z0-9]{4,}|LG[A-Z0-9]{4,})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function getFeaturedImageUrl(wpProduct) {
  try {
    const media = wpProduct._embedded?.['wp:featuredmedia'];
    if (media && media[0]) {
      return media[0].source_url || media[0].media_details?.sizes?.full?.source_url;
    }
  } catch (e) {}
  return null;
}

function getGalleryImageUrls(wpProduct) {
  const urls = [];
  const content = wpProduct.content?.rendered || '';
  const imgRegex = /src="(https:\/\/style-access\.com\/wp-content\/uploads\/[^"]+)"/g;
  let match;
  while ((match = imgRegex.exec(content)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

function getTitle(wpProduct) {
  return decodeHtmlEntities(wpProduct.title?.rendered || '');
}

function isProductShot(url) {
  if (!url) return false;
  // Room scenes / lifestyle shots
  if (/(-RS|-room|-scene|-install|-lifestyle)/i.test(url)) return false;
  // Silo / product shots
  if (/silo|_TN|_T1|redux/i.test(url)) return true;
  // Default: assume product shot (most featured images are)
  return true;
}

async function insertImage(productId, url, assetType, existingProductUrls, productsWithPrimary, counters) {
  // Check per-product URL uniqueness (same URL can be shared across products)
  const key = `${productId}::${url}`;
  if (existingProductUrls.has(key)) return;

  const hasPrimary = productsWithPrimary.has(productId);
  const finalType = (assetType === 'primary' && !hasPrimary) ? 'primary' :
                    (assetType === 'primary' && hasPrimary) ? 'alternate' : assetType;

  const sortOrder = finalType === 'primary' ? 0 :
    (await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM media_assets WHERE product_id = $1`, [productId])).rows[0].next;

  await pool.query(`
    INSERT INTO media_assets (product_id, url, asset_type, sort_order)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING
  `, [productId, url, finalType, sortOrder]);

  existingProductUrls.add(key);
  counters.newImages++;
  if (finalType === 'primary') {
    counters.newPrimaries++;
    productsWithPrimary.add(productId);
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

  // name → product (exact normalized)
  const nameToProduct = new Map();
  for (const p of products) {
    nameToProduct.set(normalizeForMatch(p.name), p);
    if (p.collection && p.name !== p.collection) {
      nameToProduct.set(normalizeForMatch(`${p.collection} ${p.name}`), p);
    }
  }

  // collection → [products] for collection-level matching
  const collectionToProducts = new Map();
  for (const p of products) {
    if (!p.collection) continue;
    const key = normalizeForMatch(p.collection);
    if (!collectionToProducts.has(key)) collectionToProducts.set(key, []);
    collectionToProducts.get(key).push(p);
  }

  // expanded name → product for abbreviation matching
  const expandedNameToProduct = new Map();
  for (const p of products) {
    expandedNameToProduct.set(expandAbbrevs(p.name), p);
    if (p.collection && p.name !== p.collection) {
      expandedNameToProduct.set(expandAbbrevs(`${p.collection} ${p.name}`), p);
    }
  }

  // Load existing images
  const { rows: existingImages } = await pool.query(`
    SELECT product_id, url FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1
  `, [vendorId]);
  const existingProductUrls = new Set(existingImages.map(i => `${i.product_id}::${i.url}`));
  const productsWithPrimary = new Set();
  const { rows: primaries } = await pool.query(`
    SELECT DISTINCT ma.product_id FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
  `, [vendorId]);
  for (const r of primaries) productsWithPrimary.add(r.product_id);

  // Track which DB products get images
  const productsWithAnyImage = new Set(existingImages.map(i => i.product_id));

  console.log(`  DB: ${products.length} products, ${skus.length} SKUs`);
  console.log(`  DB: ${productsWithPrimary.size} products already have primary image`);
  console.log(`  DB: ${productsWithAnyImage.size} products have any image`);
  console.log(`  DB: ${existingImages.length} existing image rows\n`);

  // Fetch WP products
  console.log('Fetching from WooCommerce API...');
  const wpProducts = await fetchAllWpProducts();
  console.log(`\n  Fetched ${wpProducts.length} WP products total\n`);

  const counters = { newImages: 0, newPrimaries: 0 };
  let matched = 0, skipped = 0, noMatch = 0, collectionMatches = 0;
  const unmatchedTitles = [];
  const matchLog = []; // track what matched how

  for (const wp of wpProducts) {
    const title = getTitle(wp);
    const excerpt = wp.excerpt?.rendered || '';
    const featuredUrl = getFeaturedImageUrl(wp);
    const galleryUrls = getGalleryImageUrls(wp);

    if (!featuredUrl && galleryUrls.length === 0) {
      skipped++;
      continue;
    }

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

    // Strategy 4: Fuzzy matching (prefer longest/most specific match)
    // Combines: substring contains, reversed word order, expanded abbreviations
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

        // 4a: Title contains product name (substring)
        if (normTitle.includes(normName) && normName.length > 3) {
          const score = normName.length * 10; // weight by length
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        // 4b: Expanded title contains expanded name
        if (expTitle.includes(expName) && expName.length > 3) {
          const score = expName.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        // 4c: Expanded name contains expanded title
        if (expName.includes(expTitle) && expTitle.length > 3) {
          const score = expTitle.length * 10;
          if (score > bestScore) { bestMatch = p; bestScore = score; }
        }

        // 4d: Reversed word order ("Al Hamra Papillon" ↔ "Papillon in Al Hamra")
        const nameWords = normName.replace(/\b(in|of|and|the|with)\b/g, '').replace(/\s+/g, ' ').trim().split(' ');
        if (nameWords.length >= 2 && titleWordSet.size >= 2) {
          const nameWordSet = new Set(nameWords.filter(w => w.length > 2));
          const titleInName = [...titleWordSet].every(w => nameWordSet.has(w));
          const nameInTitle = [...nameWordSet].every(w => titleWordSet.has(w));
          if ((titleInName || nameInTitle) && Math.min(titleWordSet.size, nameWordSet.size) >= 2) {
            // Reversed-word matches score higher than short substring matches
            const score = (titleWordSet.size + nameWordSet.size) * 50;
            if (score > bestScore) { bestMatch = p; bestScore = score; }
          }
        }

        // 4e: Collection context — title contains collection AND color part
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

    // Strategy 6: Collection-level match — WP title IS a collection name
    // Apply image to ALL products in that collection (especially those missing images)
    if (!productId) {
      const normTitle = normalizeForMatch(title);
      const collProducts = collectionToProducts.get(normTitle);
      if (collProducts && collProducts.length > 0) {
        collectionMatches++;
        if (VERBOSE) console.log(`  COLLECTION MATCH: "${title}" → ${collProducts.length} products`);

        if (!DRY_RUN) {
          for (const p of collProducts) {
            if (featuredUrl) {
              await insertImage(p.id, featuredUrl, isProductShot(featuredUrl) ? 'primary' : 'alternate',
                existingProductUrls, productsWithPrimary, counters);
              productsWithAnyImage.add(p.id);
            }
            for (const gUrl of galleryUrls) {
              if (gUrl === featuredUrl) continue;
              await insertImage(p.id, gUrl, isProductShot(gUrl) ? 'primary' : 'alternate',
                existingProductUrls, productsWithPrimary, counters);
              productsWithAnyImage.add(p.id);
            }
          }
        } else {
          for (const p of collProducts) productsWithAnyImage.add(p.id);
        }
        matched++;
        matchLog.push({ title, method: 'collection', count: collProducts.length });
        continue;
      }
    }

    if (!productId) {
      noMatch++;
      unmatchedTitles.push(title);
      continue;
    }

    matched++;
    if (VERBOSE) matchLog.push({ title, method: matchMethod, productId });

    if (!DRY_RUN) {
      if (featuredUrl) {
        await insertImage(productId, featuredUrl, isProductShot(featuredUrl) ? 'primary' : 'alternate',
          existingProductUrls, productsWithPrimary, counters);
        productsWithAnyImage.add(productId);
      }
      for (const gUrl of galleryUrls) {
        if (gUrl === featuredUrl) continue;
        await insertImage(productId, gUrl, isProductShot(gUrl) ? 'primary' : 'alternate',
          existingProductUrls, productsWithPrimary, counters);
        productsWithAnyImage.add(productId);
      }
    } else {
      productsWithAnyImage.add(productId);
    }
  }

  // Phase 2: Collection sibling sharing for products still missing images
  // Multiforma shares colors with Linea — use Linea images as fallback
  const SIBLING_COLLECTIONS = {
    'Multiforma': 'Linea',   // Same colors, different format
  };

  for (const [targetColl, sourceColl] of Object.entries(SIBLING_COLLECTIONS)) {
    const targetProducts = products.filter(p => p.collection === targetColl && !productsWithAnyImage.has(p.id));
    if (!targetProducts.length) continue;

    const sourceProducts = products.filter(p => p.collection === sourceColl);
    console.log(`  Sibling sharing: ${targetColl} (${targetProducts.length} missing) ← ${sourceColl} (${sourceProducts.length} source)`);

    for (const tp of targetProducts) {
      // Find source product with matching color name
      const sp = sourceProducts.find(s => normalizeForMatch(s.name) === normalizeForMatch(tp.name));
      if (!sp) continue;

      // Get source images
      const { rows: srcImages } = await pool.query(
        `SELECT url, asset_type FROM media_assets WHERE product_id = $1 ORDER BY sort_order`,
        [sp.id]
      );
      if (!srcImages.length) continue;

      if (VERBOSE) console.log(`    ${tp.name} ← ${sp.name} (${srcImages.length} images)`);

      if (!DRY_RUN) {
        for (const img of srcImages) {
          await insertImage(tp.id, img.url, img.asset_type, existingProductUrls, productsWithPrimary, counters);
        }
      }
      productsWithAnyImage.add(tp.id);
    }
  }

  // Report
  console.log(`\n=== Results ===`);
  console.log(`  WP products: ${wpProducts.length}`);
  console.log(`  Matched to DB: ${matched} (${collectionMatches} collection-level)`);
  console.log(`  No match: ${noMatch}`);
  console.log(`  Skipped (no image): ${skipped}`);
  console.log(`  New images added: ${counters.newImages}`);
  console.log(`  New primaries: ${counters.newPrimaries}`);
  console.log(`  Products with primary (before): ${primaries.length}`);
  console.log(`  Products with primary (after): ${productsWithPrimary.size}`);

  // Products that would still have no images after this
  const stillMissing = products.filter(p => !productsWithAnyImage.has(p.id));
  console.log(`\n  Products with any image (before): ${existingImages.length > 0 ? new Set(existingImages.map(i => i.product_id)).size : 0}`);
  console.log(`  Products with any image (after): ${productsWithAnyImage.size}`);
  console.log(`  Still missing images: ${stillMissing.length}`);

  if (stillMissing.length > 0) {
    console.log(`\n  --- Products still missing images ---`);
    for (const p of stillMissing) {
      console.log(`    [${p.collection || 'no-collection'}] "${p.name}"`);
    }
  }

  if (VERBOSE && matchLog.length > 0) {
    console.log(`\n  --- Match log (sample) ---`);
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
