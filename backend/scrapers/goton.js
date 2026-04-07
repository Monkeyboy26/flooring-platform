/**
 * Goton Tiles — Enrichment Scraper (standard pattern)
 *
 * Products already imported from PDF price list (~80 products, ~978 SKUs).
 * This scraper visits gotontiles.com (Wix-hosted) to capture product images
 * and scrape descriptions.
 *
 * Images are saved at the PRODUCT level (sku_id = NULL) because each Goton
 * series page shows a gallery covering all colors — individual color images
 * aren't broken out on separate pages.
 *
 * Glass mosaics (GM1xx, GM2xx, etc.) are shown on shared collection pages,
 * not individual product pages, and require special handling.
 *
 * Image strategy:
 * - Site-wide images (logo, nav, footer) collected once from homepage and excluded
 * - extractLargeImages from base.js (replaces custom extractWixImages)
 * - Cross-page deduplication via globalSeenImages prevents style-group contamination
 * - Wix product gallery targeted first, full-page fallback second
 */
import puppeteer from 'puppeteer';
import {
  delay, saveProductImages, filterImageUrls, preferProductShot,
  collectSiteWideImages, extractLargeImages,
  appendLog, addJobError,
} from './base.js';

const BASE_URL = 'https://www.gotontiles.com';
const BATCH_SIZE = 15;

// ── Slug overrides for product names that don't auto-slugify correctly ──
const SLUG_OVERRIDES = {
  'Malakas Rock':       'malakasrock',
  'Coastwood II':       'coastwood-ii',
  'Beautiful Sicily':   'beautiful-sicily',
  'Majestic Gambus':    'majestic-gambus',
  'Whitehause':         'whiteause',        // typo on site
  'Premium Whitehause': 'premium-whitehause',
  'Soslate Textured':   'soslate-textured',
  'Travertine Nuevo':   'travertine-nuevo',
  'Carrara Nuevo':      'carrara-nuevo',
  'Royal Batticino':    'royal-batticino',
  'Simpatico Concrete': 'simpatico-concrete',
  'Simpatico Wood':     'simpatico-wood',
  'Vienna Style':       'vienna-style',
  'Chebi Rock':         'chebi-rock',
  'Karst Grace':        'karst-grace',
  'Danube Waves':       'danube-waves',
  'Glacier Undulated':  'glacier',          // shares page with Glacier
  'Bella Stone':        'bella-stone',
  'Supergres Fog':      'supergres-fog',
};

// ── Alternate slugs for products with known missing-image issues ──
const MISSING_IMAGE_OVERRIDES = {
  'Cimaron':       ['cimarron', 'cimaron'],
  'Danube Waves':  ['danube-waves', 'danubewaves', 'danube'],
  'Supergres Fog': ['supergres-fog', 'supergresfog', 'supergres'],
};

// ── Glass mosaic collection pages ──
// Each entry: { slug, codePatterns[] } — products whose name contains a matching
// code get images from the corresponding collection page.
const GLASS_COLLECTION_PAGES = [
  { slug: 'glass-stone-mosaic',                              codePatterns: [/\bGM[12]\d{2}\b/i] },
  { slug: 'glass-stone-mosaic-basketweave-and-linear-line',  codePatterns: [/\bGMH\d+\b/i, /\bGML3\d+\b/i] },
  { slug: 'glass-metal-lineal-mosaic',                       codePatterns: [/\bGML4\d+\b/i] },
  { slug: 'glass-quartzite-mosaic',                          codePatterns: [/\bGM5\d+\b/i, /\bGML5\d+\b/i] },
  { slug: 'glass-tile',                                      codePatterns: [/\bVetro\b/i] },
];

// ── Krovanh uses numeric-only color codes (210–216, roto color process) ──
// No actual color names exist — fix the redundant variant_name "210 210" → "210"
const KROVANH_NUMERIC_CODES = ['210', '211', '212', '213', '214', '215', '216'];

// Generic description template to detect and replace
const GENERIC_DESC_PATTERN = /a durable porcelain tile/i;

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function resolveSlug(productName) {
  if (SLUG_OVERRIDES[productName]) return SLUG_OVERRIDES[productName];
  return slugify(productName);
}

function launchBrowserWithTimeout() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  return page;
}

/**
 * Scroll down the page to trigger lazy-loaded Wix images.
 */
async function scrollForLazyImages(page) {
  await page.evaluate(async () => {
    const step = 400;
    const pause = 300;
    const height = document.body.scrollHeight;
    for (let pos = 0; pos < height; pos += step) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, pause));
    }
    // Scroll back to top
    window.scrollTo(0, 0);
  });
  await delay(1500);
}

/**
 * Normalize a Wix image URL for deduplication.
 * Strips resize params (/v1/fill/...) and query strings to get the canonical form.
 */
function normalizeWixUrl(url) {
  // Strip Wix resize path: keep just the base media URL
  const match = url.match(/(https?:\/\/static\.wixstatic\.com\/media\/[^/]+\.\w+)/);
  const base = match ? match[1] : url;
  return base.split('?')[0].toLowerCase();
}

/**
 * Try to extract images from a Wix product gallery container specifically.
 * Returns URLs from the gallery, or empty array if no gallery container found.
 */
async function extractWixProductGallery(page) {
  return page.evaluate(() => {
    // Wix product gallery selectors
    const selectors = [
      '[data-hook="product-gallery"] img',
      '.product-gallery img',
      '[data-hook="main-media-image"]',
      '[data-hook="media-gallery-large-image"] img',
    ];
    for (const sel of selectors) {
      const imgs = document.querySelectorAll(sel);
      if (imgs.length === 0) continue;
      const urls = [];
      for (const img of imgs) {
        const src = img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) continue;
        if (img.naturalWidth > 0 && img.naturalWidth < 100) continue;
        urls.push(src);
      }
      if (urls.length > 0) return urls;
    }
    return [];
  });
}

/**
 * Extract description text from a Wix product page.
 * Tries rich text elements, font classes, and meta tags.
 */
async function extractDescription(page) {
  const desc = await page.evaluate(() => {
    // Strategy 1: Wix rich text blocks
    const richTexts = document.querySelectorAll('[data-testid="richTextElement"] p, [data-testid="richTextElement"] span');
    const texts = [];
    for (const el of richTexts) {
      const t = (el.textContent || '').trim();
      if (t.length >= 20) texts.push(t);
    }
    if (texts.length > 0) {
      // Filter out nav/boilerplate
      const boilerplate = ['home', 'shop', 'contact', 'about', 'menu', 'cart', 'login', 'sign up', 'subscribe', 'newsletter', 'follow us', 'copyright', 'all rights'];
      const good = texts.filter(t => {
        const lower = t.toLowerCase();
        return !boilerplate.some(kw => lower.startsWith(kw));
      });
      if (good.length > 0) return good.join(' ').substring(0, 500);
    }

    // Strategy 2: Wix font style classes
    for (const cls of ['.font_7', '.font_8']) {
      const els = document.querySelectorAll(cls);
      const parts = [];
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t.length >= 20) parts.push(t);
      }
      if (parts.length > 0) return parts.join(' ').substring(0, 500);
    }

    // Strategy 3: Meta description fallback
    const metaDesc = document.querySelector('meta[name="description"]')?.content
      || document.querySelector('meta[property="og:description"]')?.content
      || '';
    if (metaDesc.length >= 20) return metaDesc.substring(0, 500);

    return '';
  });

  return desc.trim();
}

/**
 * Visit a product page and extract images + description.
 * Uses base.js extractLargeImages with site-wide exclusion and cross-page dedup.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} slug
 * @param {Set<string>} siteWideImages - URLs to exclude (from homepage)
 * @param {Map<string, string>} globalSeenImages - cross-page dedup map (normalizedUrl → productName)
 * @param {string} productName - for dedup tracking
 * @param {number} extraWait - ms to wait for Wix hydration
 * @returns {{ images: string[], description: string }}
 */
async function scrapeProductPage(page, slug, siteWideImages, globalSeenImages, productName, extraWait = 3000) {
  const url = `${BASE_URL}/product-page/${slug}`;
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    if (!resp || resp.status() >= 400) {
      return { images: [], description: '' };
    }

    // Wait for Wix Thunderbolt hydration
    await delay(extraWait);

    // Scroll to trigger lazy-loaded gallery images
    await scrollForLazyImages(page);

    // Strategy 1: Try Wix product gallery container first
    let rawUrls = await extractWixProductGallery(page);

    // Strategy 2: Fall back to extractLargeImages from base.js
    if (rawUrls.length === 0) {
      const largeImgs = await extractLargeImages(page, siteWideImages, 150);
      rawUrls = largeImgs.map(img => img.src);
    }

    // Convert to full-res (strip Wix resize params)
    rawUrls = rawUrls.map(u => {
      const match = u.match(/(https?:\/\/static\.wixstatic\.com\/media\/[^/]+\.\w+)/);
      return match ? match[1] : u;
    });

    // Filter junk
    const filtered = filterImageUrls(rawUrls, { maxImages: 12 });

    // Cross-page deduplication: only keep images not seen on other products
    const unique = [];
    for (const imgUrl of filtered) {
      const norm = normalizeWixUrl(imgUrl);
      const owner = globalSeenImages.get(norm);
      if (!owner) {
        globalSeenImages.set(norm, productName);
        unique.push(imgUrl);
      }
      // If already seen by same product (e.g. retry with alt slug), still keep it
      else if (owner === productName) {
        unique.push(imgUrl);
      }
      // Otherwise skip — belongs to another product (cross-contamination)
    }

    const images = preferProductShot(unique).slice(0, 8);
    const description = await extractDescription(page);

    return { images, description };
  } catch (err) {
    return { images: [], description: '' };
  }
}

/**
 * Determine which glass collection page a product belongs to, if any.
 * Uses regex matching to find codes anywhere in the product name
 * (works with both old "GM101 5/8x5/8" and new "Glass Stone Mosaic GM101" formats).
 */
function getGlassCollectionSlug(productName) {
  for (const { slug, codePatterns } of GLASS_COLLECTION_PAGES) {
    for (const pattern of codePatterns) {
      if (pattern.test(productName)) return slug;
    }
  }
  return null;
}

/**
 * Extract glass mosaic code from product name.
 * Matches GM/GML/GMH codes anywhere in the name.
 */
function extractGlassCode(productName) {
  const match = productName.match(/\b(GM[LH]?\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Fix Krovanh redundant variant_name: "210 210 9x36" → "210 9x36".
 * Krovanh uses numeric-only roto color codes — no actual color names exist.
 */
async function fixKrovanhVariantNames(pool, vendorId, log) {
  let fixed = 0;
  for (const code of KROVANH_NUMERIC_CODES) {
    // Fix variant_name: "210 210 ..." → "210 ..."
    const res = await pool.query(`
      UPDATE skus s SET variant_name = REPLACE(variant_name, $1, $2)
      FROM products p
      WHERE s.product_id = p.id AND p.vendor_id = $3 AND p.name = 'Krovanh'
        AND s.variant_name LIKE $4
    `, [`${code} ${code}`, code, vendorId, `%${code} ${code}%`]);
    fixed += res.rowCount;
  }
  if (fixed > 0) await log(`Fixed ${fixed} Krovanh redundant variant names`);
}

/**
 * Generate a fallback description from DB attributes when scraping finds nothing.
 * E.g.: "Coastwood is a porcelain tile from Goton Tiles, available in Pismo, Venice, Malibu. Sizes: 6x36, 9x36."
 */
async function generateFallbackDescription(pool, productId, productName) {
  const attrRes = await pool.query(`
    SELECT a.slug, array_agg(DISTINCT sa.value ORDER BY sa.value) AS vals
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    JOIN skus s ON s.id = sa.sku_id
    WHERE s.product_id = $1 AND a.slug IN ('color', 'size', 'material')
    GROUP BY a.slug
  `, [productId]);

  const attrs = {};
  for (const row of attrRes.rows) attrs[row.slug] = row.vals;

  const material = (attrs.material || ['porcelain tile'])[0].toLowerCase();
  const colors = attrs.color || [];
  const sizes = attrs.size || [];

  let desc = `${productName} is a ${material} from Goton Tiles`;
  if (colors.length > 0) desc += `, available in ${colors.join(', ')}`;
  if (sizes.length > 0) desc += `. Sizes: ${sizes.join(', ')}`;
  desc += '.';

  return desc;
}

/**
 * Update product description only if current one is generic or missing.
 */
async function updateDescription(pool, productId, description) {
  if (!description || description.length < 20) return false;
  const res = await pool.query(`
    UPDATE products SET description_short = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
      AND (description_short IS NULL OR description_short = '' OR description_short ~* 'a durable porcelain tile')
  `, [description, productId]);
  return res.rowCount > 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main run function — standard scraper pattern
// ══════════════════════════════════════════════════════════════════════════════

export async function run(pool, job, source) {
  const vendorId = source.vendor_id;

  const log = async (msg, counters) => {
    console.log(`[goton] ${msg}`);
    await appendLog(pool, job.id, msg, counters).catch(() => {});
  };
  const logError = async (msg) => {
    console.error(`[goton] ERROR: ${msg}`);
    await addJobError(pool, job.id, msg).catch(() => {});
  };

  // ── Phase 0: Fix Krovanh redundant variant names ──
  await log('Phase 0: Fixing Krovanh variant names...');
  await fixKrovanhVariantNames(pool, vendorId, log);

  // ── Get all Goton products ──
  const productRows = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_short
    FROM products p
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // ── Check which products already have a primary image ──
  const existingImages = await pool.query(`
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

  // ── Split products into regular (individual pages) vs glass (collection pages) ──
  const regularProducts = [];
  const glassProducts = new Map(); // slug → product[]
  const needDescriptionOnly = []; // products with images but generic description

  for (const row of productRows.rows) {
    const hasGenericDesc = !row.description_short || GENERIC_DESC_PATTERN.test(row.description_short);

    if (alreadyHaveImages.has(row.id)) {
      // Already has images — still check if description needs updating
      if (hasGenericDesc) needDescriptionOnly.push(row);
      continue;
    }

    const collectionSlug = getGlassCollectionSlug(row.name);
    if (collectionSlug) {
      if (!glassProducts.has(collectionSlug)) glassProducts.set(collectionSlug, []);
      glassProducts.get(collectionSlug).push(row);
    } else {
      regularProducts.push(row);
    }
  }

  const skipped = alreadyHaveImages.size;
  const totalToScrape = regularProducts.length + [...glassProducts.values()].reduce((n, arr) => n + arr.length, 0);

  await log(`Found ${productRows.rowCount} Goton products`);
  await log(`Already have images: ${skipped} (${needDescriptionOnly.length} need description update)`);
  await log(`Regular products to scrape: ${regularProducts.length}`);
  await log(`Glass mosaic products: ${totalToScrape - regularProducts.length} (across ${glassProducts.size} collection pages)`);

  let imagesSaved = 0;
  let productsMatched = 0;
  let productsFailed = 0;
  let descriptionsUpdated = 0;
  let browser = await launchBrowserWithTimeout();
  let pagesSinceLaunch = 0;

  // Cross-page image deduplication: tracks every image URL seen across all products
  // Map<normalizedUrl, productName> — first product to claim an image owns it
  const globalSeenImages = new Map();

  try {
    let page = await createPage(browser);

    // ── Collect site-wide images from homepage for exclusion ──
    await log('Collecting site-wide images from homepage...');
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await log(`  Collected ${siteWideImages.size} site-wide images to exclude`);
    pagesSinceLaunch++;

    // ══════════════════════════════════════════════════════════════════════
    // REGULAR PRODUCTS — each has its own /product-page/{slug}
    // ══════════════════════════════════════════════════════════════════════
    for (const product of regularProducts) {
      // Recycle browser periodically
      if (pagesSinceLaunch >= BATCH_SIZE) {
        await log(`Recycling browser after ${BATCH_SIZE} pages, pausing 15s...`);
        try { await page.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
        await delay(15000);
        browser = await launchBrowserWithTimeout();
        page = await createPage(browser);
        pagesSinceLaunch = 0;
      }

      const slug = resolveSlug(product.name);
      await log(`Scraping: ${product.name} → /product-page/${slug}`);

      let result = await scrapeProductPage(page, slug, siteWideImages, globalSeenImages, product.name);
      pagesSinceLaunch++;

      // If no images found, try alternate slugs for known problematic products
      if (result.images.length === 0 && MISSING_IMAGE_OVERRIDES[product.name]) {
        for (const altSlug of MISSING_IMAGE_OVERRIDES[product.name]) {
          if (altSlug === slug) continue; // already tried
          await log(`  Retrying ${product.name} with alternate slug: ${altSlug}`);
          result = await scrapeProductPage(page, altSlug, siteWideImages, globalSeenImages, product.name, 5000);
          pagesSinceLaunch++;
          if (result.images.length > 0) break;
        }
      }

      // Update description (from scrape or fallback)
      let desc = result.description;
      if (!desc || desc.length < 20) {
        desc = await generateFallbackDescription(pool, product.id, product.name);
      }
      if (await updateDescription(pool, product.id, desc)) {
        descriptionsUpdated++;
      }

      if (result.images.length === 0) {
        await logError(`No images found for ${product.name} (tried slug: ${slug})`);
        productsFailed++;
        await delay(2000);
        continue;
      }

      const saved = await saveProductImages(pool, product.id, result.images, { maxImages: 6 });
      imagesSaved += saved;
      productsMatched++;
      await log(`  Saved ${saved} unique image(s) for ${product.name}`);
      await delay(2000 + Math.random() * 1000);
    }

    // ══════════════════════════════════════════════════════════════════════
    // GLASS MOSAIC COLLECTION PAGES
    // ══════════════════════════════════════════════════════════════════════
    if (glassProducts.size > 0) {
      await log('Scraping glass mosaic collection pages...');
    }

    for (const [collectionSlug, products] of glassProducts) {
      // Recycle browser if needed
      if (pagesSinceLaunch >= BATCH_SIZE) {
        await log(`Recycling browser after ${BATCH_SIZE} pages, pausing 15s...`);
        try { await page.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
        await delay(15000);
        browser = await launchBrowserWithTimeout();
        page = await createPage(browser);
        pagesSinceLaunch = 0;
      }

      await log(`Collection: /product-page/${collectionSlug} (${products.length} products)`);

      // Scrape collection page (use a temp name so globalSeenImages doesn't over-claim)
      const result = await scrapeProductPage(page, collectionSlug, siteWideImages, globalSeenImages, `__glass_${collectionSlug}`);
      pagesSinceLaunch++;

      if (result.images.length === 0) {
        await logError(`No images for glass collection: ${collectionSlug}`);
        productsFailed += products.length;
        await delay(2000);
        continue;
      }

      // Try to match images to specific products by code in the URL
      const unmatched = [];
      const matchedByCode = new Map(); // productId → urls[]

      for (const url of result.images) {
        const urlLower = url.toLowerCase();
        let matched = false;
        for (const product of products) {
          const code = extractGlassCode(product.name);
          if (code && urlLower.includes(code.toLowerCase())) {
            if (!matchedByCode.has(product.id)) matchedByCode.set(product.id, []);
            matchedByCode.get(product.id).push(url);
            matched = true;
            break;
          }
        }
        if (!matched) unmatched.push(url);
      }

      // Save matched images to specific products
      for (const [productId, urls] of matchedByCode) {
        const saved = await saveProductImages(pool, productId, urls, { maxImages: 4 });
        imagesSaved += saved;
        productsMatched++;
      }

      // For unmatched products, use the collection page's shared images
      const sharedImages = unmatched.length > 0 ? unmatched : result.images.slice(0, 3);
      for (const product of products) {
        if (matchedByCode.has(product.id)) continue;
        const saved = await saveProductImages(pool, product.id, sharedImages, { maxImages: 3 });
        imagesSaved += saved;
        productsMatched++;
      }

      const specificCount = matchedByCode.size;
      const sharedCount = products.length - specificCount;
      await log(`  ${result.images.length} images — ${specificCount} matched by code, ${sharedCount} got shared images`);

      // Generate fallback descriptions for glass mosaic products
      for (const product of products) {
        const desc = await generateFallbackDescription(pool, product.id, product.name);
        if (await updateDescription(pool, product.id, desc)) descriptionsUpdated++;
      }

      await delay(2000 + Math.random() * 1000);
    }

    // ══════════════════════════════════════════════════════════════════════
    // DESCRIPTION-ONLY PASS — products with images but generic descriptions
    // ══════════════════════════════════════════════════════════════════════
    if (needDescriptionOnly.length > 0) {
      await log(`Updating descriptions for ${needDescriptionOnly.length} products with existing images...`);

      for (const product of needDescriptionOnly) {
        // Try scraping the product page for a real description first
        const slug = resolveSlug(product.name);
        const collectionSlug = getGlassCollectionSlug(product.name);

        let desc = '';
        if (!collectionSlug) {
          // Only visit regular product pages (not glass collection pages for desc)
          if (pagesSinceLaunch >= BATCH_SIZE) {
            await log(`Recycling browser after ${BATCH_SIZE} pages, pausing 15s...`);
            try { await page.close(); } catch (_) {}
            try { await browser.close(); } catch (_) {}
            await delay(15000);
            browser = await launchBrowserWithTimeout();
            page = await createPage(browser);
            pagesSinceLaunch = 0;
          }

          const result = await scrapeProductPage(page, slug, siteWideImages, globalSeenImages, product.name);
          pagesSinceLaunch++;
          desc = result.description;
          await delay(1000 + Math.random() * 500);
        }

        // Fallback to generated description
        if (!desc || desc.length < 20) {
          desc = await generateFallbackDescription(pool, product.id, product.name);
        }
        if (await updateDescription(pool, product.id, desc)) {
          descriptionsUpdated++;
        }
      }
    }

    // ── Summary ──
    await log('=== Scrape Complete ===');
    await log(`Products already had images: ${skipped}`);
    await log(`Products matched this run: ${productsMatched} / ${totalToScrape}`);
    await log(`Products with no images: ${productsFailed}`);
    await log(`Total images saved: ${imagesSaved}`);
    await log(`Descriptions updated: ${descriptionsUpdated}`);
    await log(`Cross-page dedup: ${globalSeenImages.size} unique image URLs tracked`);

    await appendLog(pool, job.id, 'Done', {
      products_found: productRows.rowCount,
      products_updated: productsMatched + descriptionsUpdated,
    }).catch(() => {});

  } finally {
    try { await browser.close(); } catch (_) {}
  }
}
