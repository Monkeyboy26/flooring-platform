#!/usr/bin/env node
/**
 * scrape-msi-transitions.mjs
 *
 * Scrapes VTT-prefixed transition accessory SKUs (T-Molding, Reducer, Stair Nose,
 * Quarter Round, End Cap, etc.) from MSI product detail pages and upserts them
 * into the database, linked to their parent LVP/hardwood products by color code.
 *
 * The EDI 832 feed does NOT include these accessories — they only exist on the
 * MSI website in a "Trims" accordion on each product page.
 *
 * Usage:
 *   docker exec flooring-api node scripts/scrape-msi-transitions.mjs --dry-run
 *   docker exec flooring-api node scripts/scrape-msi-transitions.mjs
 *   docker exec flooring-api node scripts/scrape-msi-transitions.mjs --limit 5
 */

import pg from 'pg';
import {
  launchBrowser, delay,
  upsertSku, upsertSkuAttribute, saveSkuImages, upsertMediaAsset,
} from '../scrapers/base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const limitArg = process.argv.indexOf('--limit');
const PAGE_LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants — copied from msi-unified.js to keep this script standalone
// ═══════════════════════════════════════════════════════════════════════════════

const TRIM_NAMES = {
  'ST-EE-W': 'Stair Tread Wide',
  'FSNL-EE': 'Flush Stair Nose Long', 'FSN-EE': 'Flush Stair Nose',
  'ST-EE': 'Stair Tread', 'T-SR': 'T-Molding Reducer',
  '4-IN-1': '4-in-1 Transition', 'FSNL': 'Flush Stair Nose Long',
  'FSN': 'Flush Stair Nose', 'OSN': 'Overlapping Stair Nose',
  'SRL': 'Reducer Long', 'ECL': 'End Cap Long', 'EC': 'End Cap',
  'QR': 'Quarter Round', 'SR': 'Reducer', 'ST': 'Stair Tread',
  'RT': 'Riser Tread', 'T': 'T-Molding',
};

const _trimCodeAlt = Object.keys(TRIM_NAMES)
  .sort((a, b) => b.length - a.length)
  .map(c => c.replace(/-/g, '\\-'))
  .join('|');
const TRIM_CODE_REGEX = new RegExp(`-(${_trimCodeAlt})$`, 'i');

/** Extract color code from a VTT accessory SKU */
function extractAccColorCode(sku) {
  let m;
  m = sku.match(/^P-VTT(?:HD)?([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^VTTHD([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^VTT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^TT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  return null;
}

/** Extract color code from a main VTR/VTW flooring SKU */
function extractMainColorCodes(sku) {
  const m = sku.match(/^(?:P-)?(?:VTR|VTW|QUTR|QUPO)(?:XL)?(?:HD)?([A-Z]+)/i);
  if (m && m[1].length >= 3) {
    const code = m[1].toUpperCase();
    const codes = [code];
    if (code.startsWith('XL') && code.length > 4) codes.push(code.slice(2));
    return codes;
  }
  return [];
}

/** Derive variant name from VTT vendor_sku */
function parseTrimVariantName(vendorSku) {
  const m = vendorSku.match(TRIM_CODE_REGEX);
  if (m) return TRIM_NAMES[m[1].toUpperCase()] || m[1];
  return null;
}

// MSI website collection pages for LVP and hardwood
const MSI_LVP_CATEGORIES = [
  '/luxury-vinyl-flooring/cyrus/',
  '/luxury-vinyl-flooring/andover/',
  '/luxury-vinyl-flooring/everlife-xl-cyrus/',
  '/luxury-vinyl-flooring/xl-cyrus/',
  '/luxury-vinyl-flooring/xxl-cyrus/',
  '/luxury-vinyl-flooring/prescott/',
  '/luxury-vinyl-flooring/everlife-prescott/',
  '/luxury-vinyl-flooring/bracken-hill/',
  '/luxury-vinyl-flooring/everlife/',
  '/waterproof-hybrid-rigid-core/',
];

const MSI_HARDWOOD_CATEGORIES = [
  '/w-luxury-genuine-hardwood/',
  '/waterproof-wood-flooring/woodhills/',
];

// ═══════════════════════════════════════════════════════════════════════════════
// Step 1 — Load existing MSI products and build color-code index
// ═══════════════════════════════════════════════════════════════════════════════

async function loadMsiParentIndex() {
  // Get MSI vendor_id
  const { rows: [vendor] } = await pool.query(
    `SELECT id FROM vendors WHERE code = 'MSI'`
  );
  if (!vendor) throw new Error('MSI vendor not found');
  const vendorId = vendor.id;

  // Load all MSI LVP + hardwood SKUs with their color attributes
  const { rows: parentSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.variant_name,
           p.name AS product_name, p.collection,
           c.slug AS category_slug,
           (SELECT sa.value FROM sku_attributes sa
            JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'color'
            LIMIT 1) AS color_value
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1
      AND c.slug IN ('lvp-plank', 'engineered-hardwood')
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND s.status = 'active'
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Loaded ${parentSkus.length} MSI LVP/hardwood parent SKUs`);

  // Build color-code → product_id mapping
  const colorToProduct = new Map(); // colorCode → { product_id, product_name, collection, color_value }
  for (const sku of parentSkus) {
    const codes = extractMainColorCodes(sku.vendor_sku);
    for (const code of codes) {
      if (!colorToProduct.has(code)) {
        colorToProduct.set(code, {
          product_id: sku.product_id,
          product_name: sku.product_name,
          collection: sku.collection,
          color_value: sku.color_value,
          category_slug: sku.category_slug,
        });
      }
    }
  }

  console.log(`Built color-code index: ${colorToProduct.size} unique codes`);
  if (VERBOSE) {
    for (const [code, info] of colorToProduct) {
      console.log(`  ${code} → ${info.product_name} (${info.collection})`);
    }
  }

  return { vendorId, colorToProduct, parentSkus };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 2 — Discover product page URLs from MSI collection pages
// ═══════════════════════════════════════════════════════════════════════════════

async function collectProductUrls(browser, categoryUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('[data-href], .new-filter-collection a[href], a.owl-log', { timeout: 15000 }).catch(() => {});
    await delay(2000);

    // Click "Load More Products" repeatedly
    let previousCount = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const loadMoreBtn = await page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a, button'));
        return links.find(el => {
          const text = el.textContent.trim().toLowerCase();
          if (!text.includes('load more')) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        }) || null;
      });
      const isElement = await loadMoreBtn.evaluate(el => el !== null).catch(() => false);
      if (!isElement) break;
      await loadMoreBtn.click().catch(() => {});
      await delay(2000);
      const currentCount = await page.$$eval('[data-href]', els => els.length).catch(() => 0);
      if (currentCount <= previousCount) break;
      previousCount = currentCount;
    }

    const baseHost = new URL(categoryUrl).origin;
    const urls = await page.evaluate((baseHost) => {
      const seen = new Set();
      const results = [];

      document.querySelectorAll('[data-href]').forEach(el => {
        let href = el.getAttribute('data-href');
        if (!href || href === '#' || href.includes('javascript:')) return;
        if (href.startsWith('/')) href = baseHost + href;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      document.querySelectorAll('.new-filter-collection a[href]').forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (href && href.startsWith('/')) href = baseHost + href;
        if (!href || href.includes('javascript:') || href === '#') return;
        try { if (new URL(href).origin !== baseHost) return; } catch { return; }
        if (/\.(pdf|jpg|png|gif|svg|mp4)(\?|$)/i.test(href)) return;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      document.querySelectorAll('a.owl-log[href]').forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (href && href.startsWith('/')) href = baseHost + href;
        if (!href || href.includes('javascript:') || href === '#') return;
        try { if (new URL(href).origin !== baseHost) return; } catch { return; }
        if (/\.(pdf|jpg|png|gif|svg|mp4)(\?|$)/i.test(href)) return;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      return results.filter(url =>
        !url.includes('/site-search') &&
        !url.includes('/gallery/') &&
        !url.includes('/videos/') &&
        !url.includes('/blog/') &&
        !url.includes('?')
      );
    }, baseHost);

    return urls.slice(0, 800);
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 3 — Scrape VTT trim data from a product detail page
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Visit a product page, expand the Trims accordion, and extract VTT SKU data.
 * Returns array of { vendor_sku, trimType, size, imageUrl, pageUrl }
 */
async function scrapeTrimsFromPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    // Navigate with retry for rate limiting
    let retries = 0;
    while (retries < 3) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      if (/too many requests|429|rate limit/i.test(bodySnippet)) {
        retries++;
        console.log(`  Rate limited, waiting ${5 * retries}s...`);
        await delay(5000 * retries);
        continue;
      }
      break;
    }

    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});

    // Expand all accordions (including "Trims" section)
    await page.evaluate(() => {
      document.querySelectorAll('.accordion-header, [data-toggle="collapse"], button[aria-expanded="false"]')
        .forEach(t => { try { t.click(); } catch { } });
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show');
        el.style.display = '';
        el.style.height = 'auto';
      });
      document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('active', 'in', 'show');
        el.style.display = '';
      });
    });
    await delay(1500);

    // Extract VTT trim data from the page
    const trims = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Strategy 1: Look for VTT-prefixed data-id attributes (buttons/elements with SKU codes)
      document.querySelectorAll('[data-id]').forEach(el => {
        const code = (el.getAttribute('data-id') || '').trim();
        if (!code || !(/^(P-)?VTT/i.test(code) || /^TT[A-Z]/i.test(code))) return;
        if (seen.has(code.toUpperCase())) return;
        seen.add(code.toUpperCase());

        // Find nearby image
        let imageUrl = '';
        const container = el.closest('.size-spec, .border-bottom, .trim-item, .accordion-body, tr, li, [class*="trim"], [class*="accessory"]') || el.parentElement;
        if (container) {
          const img = container.querySelector('img[src*="cdn.msisurfaces.com"]');
          if (img && !img.src.includes('.svg')) imageUrl = img.src;
        }

        // Find size info
        let size = '';
        if (container) {
          const sizeMatch = container.textContent.match(/(\d+(?:\.\d+)?)\s*["″]?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*["″]?/);
          if (sizeMatch) size = sizeMatch[1] + 'x' + sizeMatch[2];
        }

        results.push({ vendor_sku: code, size, imageUrl });
      });

      // Strategy 2: Search body text for ID# lines with VTT codes
      const bodyText = document.body.innerText || '';
      const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const idMatch = lines[i].match(/^ID#:\s*((P-)?VTT[A-Z0-9][\w-]{4,})/i)
                     || lines[i].match(/^ID#:\s*(TT[A-Z][\w-]{4,})/i);
        if (!idMatch) continue;
        const code = idMatch[1].trim();
        if (seen.has(code.toUpperCase())) continue;
        seen.add(code.toUpperCase());

        let size = '';
        // Check preceding line for dimensions
        if (i > 0) {
          const sizeMatch = lines[i - 1].match(/(\d+(?:\.\d+)?)\s*["″]?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*["″]?/);
          if (sizeMatch) size = sizeMatch[1] + 'x' + sizeMatch[2];
        }

        results.push({ vendor_sku: code, size, imageUrl: '' });
      }

      // Strategy 3: Scan for VTT patterns in all text on the page
      const vttPattern = /\b((?:P-)?VTT(?:HD)?[A-Z]+-(?:[A-Z0-9][\w-]*))\b/gi;
      const ttPattern = /\b(TT[A-Z]{3,}-(?:[A-Z0-9][\w-]*))\b/gi;
      for (const pattern of [vttPattern, ttPattern]) {
        let match;
        while ((match = pattern.exec(bodyText)) !== null) {
          const code = match[1].trim();
          if (seen.has(code.toUpperCase())) continue;
          // Validate it looks like a real VTT sku (has a trim suffix)
          if (!/-(FSN|OSN|EC|ECL|QR|SR|SRL|ST|RT|T|FSNL|4-IN-1|T-SR|FSN-EE|FSNL-EE|ST-EE|ST-EE-W)\b/i.test(code)) continue;
          seen.add(code.toUpperCase());
          results.push({ vendor_sku: code, size: '', imageUrl: '' });
        }
      }

      return results;
    });

    // Also try to grab VTT images from the trim section specifically
    const trimImages = await page.evaluate(() => {
      const map = {};
      // Look for images near VTT codes
      document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
        const src = img.src || '';
        if (src.includes('.svg') || src.includes('icon') || src.includes('logo')) return;
        // Check if nearby text contains a VTT code
        const parent = img.closest('.size-spec, .border-bottom, tr, li, .trim-item, [class*="trim"]') || img.parentElement;
        if (!parent) return;
        const text = parent.textContent || '';
        const vttMatch = text.match(/((?:P-)?VTT(?:HD)?[A-Z]+[\w-]+)/i) || text.match(/(TT[A-Z]{3,}[\w-]+)/i);
        if (vttMatch) {
          map[vttMatch[1].toUpperCase()] = src;
        }
      });
      return map;
    });

    // Merge images into trims
    for (const trim of trims) {
      if (!trim.imageUrl) {
        trim.imageUrl = trimImages[trim.vendor_sku.toUpperCase()] || '';
      }
    }

    return trims;
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 4 — Match VTT SKUs to parent products and upsert
// ═══════════════════════════════════════════════════════════════════════════════

async function upsertVttSku(vendorId, colorToProduct, trim, categoryId) {
  const vendorSku = trim.vendor_sku.toUpperCase().replace(/\s+/g, '-');
  const internalSku = 'MSI-' + vendorSku;

  // Extract color code and match to parent
  const colorCode = extractAccColorCode(vendorSku);
  if (!colorCode) {
    if (VERBOSE) console.log(`    Skip ${vendorSku}: no color code extracted`);
    return null;
  }

  let parent = colorToProduct.get(colorCode);
  // Fuzzy match: try substring matching
  if (!parent) {
    for (const [code, info] of colorToProduct) {
      if (code.includes(colorCode) || colorCode.includes(code)) {
        parent = info;
        break;
      }
    }
  }

  if (!parent) {
    if (VERBOSE) console.log(`    Skip ${vendorSku}: no parent match for color code "${colorCode}"`);
    return null;
  }

  // Derive variant name from SKU suffix
  const variantName = parseTrimVariantName(vendorSku) || 'Trim';

  if (DRY_RUN) {
    console.log(`    [DRY RUN] Would upsert: ${vendorSku} → ${parent.product_name} as "${variantName}"`);
    return { vendor_sku: vendorSku, parent: parent.product_name, variantName };
  }

  // Upsert the SKU
  const skuResult = await upsertSku(pool, {
    product_id: parent.product_id,
    vendor_sku: vendorSku,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: 'unit',
    variant_type: 'accessory',
  });

  const skuId = skuResult.id;

  // Set color attribute to match parent
  if (parent.color_value) {
    await upsertSkuAttribute(pool, skuId, 'color', parent.color_value);
  }

  // Save image if available
  if (trim.imageUrl) {
    await saveSkuImages(pool, parent.product_id, skuId, [trim.imageUrl], { maxImages: 1 });
  }

  // Set size attribute if available
  if (trim.size) {
    await upsertSkuAttribute(pool, skuId, 'size', trim.size);
  }

  return { vendor_sku: vendorSku, skuId, parent: parent.product_name, variantName, isNew: skuResult.is_new };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`scrape-msi-transitions.mjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // Step 1: Load parent index
  console.log('\nStep 1: Loading MSI parent product index...');
  const { vendorId, colorToProduct } = await loadMsiParentIndex();

  if (colorToProduct.size === 0) {
    console.log('No parent products found. Run the MSI EDI import first.');
    return;
  }

  // Get category_id for luxury-vinyl
  const { rows: [lvpCat] } = await pool.query(
    `SELECT id FROM categories WHERE slug = 'luxury-vinyl'`
  );

  // Step 2: Discover product page URLs
  console.log('\nStep 2: Discovering product page URLs...');
  const allCategories = [...MSI_LVP_CATEGORIES, ...MSI_HARDWOOD_CATEGORIES];
  const allProductUrls = [];
  const visitedUrls = new Set();

  let browser;
  try {
    browser = await launchBrowser();

    for (const categoryPath of allCategories) {
      const categoryUrl = 'https://www.msisurfaces.com' + categoryPath;
      console.log(`  Category: ${categoryPath}`);

      try {
        const urls = await collectProductUrls(browser, categoryUrl);
        let added = 0;
        for (const url of urls) {
          const normalized = url.replace(/\/$/, '').toLowerCase();
          if (!visitedUrls.has(normalized)) {
            visitedUrls.add(normalized);
            allProductUrls.push(url);
            added++;
          }
        }
        console.log(`    Found ${urls.length} products (${added} new)`);
      } catch (err) {
        console.log(`    ERROR: ${err.message}`);
      }

      await delay(2000);
    }

    console.log(`\nTotal unique product pages: ${allProductUrls.length}`);

    // Apply --limit
    const pagesToScrape = allProductUrls.slice(0, PAGE_LIMIT);
    if (PAGE_LIMIT < allProductUrls.length) {
      console.log(`  (limited to ${PAGE_LIMIT} pages via --limit)`);
    }

    // Step 3: Scrape VTT trims from each product page
    console.log('\nStep 3: Scraping VTT trims from product pages...');
    let totalTrims = 0;
    let totalUpserted = 0;
    let totalNew = 0;
    let totalSkipped = 0;
    let totalPages = 0;
    let pagesWithTrims = 0;

    for (let i = 0; i < pagesToScrape.length; i++) {
      const url = pagesToScrape[i];
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || url;

      try {
        const trims = await scrapeTrimsFromPage(browser, url);
        totalPages++;

        if (trims.length > 0) {
          pagesWithTrims++;
          if (VERBOSE || DRY_RUN) {
            console.log(`  [${i + 1}/${pagesToScrape.length}] ${slug}: ${trims.length} VTT trims`);
          }

          for (const trim of trims) {
            totalTrims++;
            const result = await upsertVttSku(vendorId, colorToProduct, trim, lvpCat?.id);
            if (result) {
              totalUpserted++;
              if (result.isNew) totalNew++;
            } else {
              totalSkipped++;
            }
          }
        } else if (VERBOSE) {
          console.log(`  [${i + 1}/${pagesToScrape.length}] ${slug}: no trims`);
        }

        // Progress update every 25 pages
        if ((i + 1) % 25 === 0) {
          console.log(`  Progress: ${i + 1}/${pagesToScrape.length} pages, ${totalTrims} trims found, ${totalUpserted} upserted`);
        }
      } catch (err) {
        console.log(`  ERROR on ${slug}: ${err.message}`);
      }

      // Rate limiting: 2.5s between pages
      await delay(2500);
    }

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('Summary:');
    console.log(`  Pages scraped: ${totalPages}`);
    console.log(`  Pages with trims: ${pagesWithTrims}`);
    console.log(`  VTT trims found: ${totalTrims}`);
    console.log(`  Upserted: ${totalUpserted} (${totalNew} new)`);
    console.log(`  Skipped (no match): ${totalSkipped}`);

    if (!DRY_RUN && totalUpserted > 0) {
      console.log(`\nNext step: Run build-sku-accessories.cjs to create junction links:`);
      console.log(`  docker exec flooring-api node scripts/build-sku-accessories.cjs`);
    }

  } finally {
    if (browser) await browser.close();
  }
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
