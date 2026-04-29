#!/usr/bin/env node
/**
 * MSI Recovery — Web Scrape
 *
 * Emergency recovery script: crawls MSI website to recreate products/SKUs
 * that were lost when the full 832 EDI file was no longer available on FTP.
 *
 * Creates products and SKUs from web data (no pricing — that comes from EDI).
 * Run inside Docker: docker exec flooring-api node /app/scripts/msi-recovery-web.cjs
 *
 * Usage:
 *   node backend/scripts/msi-recovery-web.cjs [--dry-run] [--category=/luxury-vinyl-flooring/]
 */

const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_CAT = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const BASE_URL = 'https://www.msisurfaces.com';
const DELAY_MS = 2500;

// All MSI product category paths
const CATEGORIES = [
  // LVP / Vinyl
  '/luxury-vinyl-flooring/',
  '/waterproof-hybrid-rigid-core/',
  // Hardwood
  '/w-luxury-genuine-hardwood/',
  '/waterproof-wood-flooring/woodhills/',
  // Tile
  '/porcelain-tile/',
  '/marble-tile/',
  '/travertine-tile/',
  '/granite-tile/',
  '/quartzite-tile/',
  '/slate-tile/',
  '/sandstone-tile/',
  '/limestone-tile/',
  '/onyx-tile/',
  '/wood-look-tile-and-planks/',
  '/large-format-tile/',
  '/commercial-tile/',
  // Backsplash / Wall
  '/backsplash-tile/subway-tile/',
  '/backsplash-tile/glass-tile/',
  '/backsplash-tile/geometric-pattern/',
  '/backsplash-tile/bevollo-glass-tile/',
  '/backsplash-tile/rio-lago-pebbles-mosaics/',
  '/backsplash-tile/waterjet-cut-mosaics/',
  '/backsplash-tile/stik-wall-tile/',
  '/backsplash-tile/wood-look-wall-tile/',
  '/backsplash-tile/brickstaks/',
  '/backsplash-tile/acoustic-wood-slat/',
  '/backsplash-tile/stacked-stone-collection/',
  '/backsplash-tile/encaustic-pattern/',
  '/backsplash-tile/luxor/',
  '/backsplash-tile/revaso-recycled-glass/',
  '/backsplash-tile/specialty-shapes-wall-tile/',
  '/mosaics/collections-mosaics/',
  '/fluted-looks/',
  // Hardscaping
  '/hardscape/rockmount-stacked-stone/',
  '/hardscape/arterra-porcelain-pavers/',
  '/evergrass-turf/',
];

// Category path → DB category slug mapping
const CATEGORY_MAP = {
  '/luxury-vinyl-flooring/': 'lvp-plank',
  '/waterproof-hybrid-rigid-core/': 'lvp-plank',
  '/w-luxury-genuine-hardwood/': 'engineered-hardwood',
  '/waterproof-wood-flooring/woodhills/': 'waterproof-wood',
  '/porcelain-tile/': 'porcelain-tile',
  '/marble-tile/': 'natural-stone',
  '/travertine-tile/': 'natural-stone',
  '/granite-tile/': 'natural-stone',
  '/quartzite-tile/': 'natural-stone',
  '/slate-tile/': 'natural-stone',
  '/sandstone-tile/': 'natural-stone',
  '/limestone-tile/': 'natural-stone',
  '/onyx-tile/': 'natural-stone',
  '/wood-look-tile-and-planks/': 'porcelain-tile',
  '/large-format-tile/': 'porcelain-tile',
  '/commercial-tile/': 'porcelain-tile',
  '/backsplash-tile/subway-tile/': 'mosaic-tile',
  '/backsplash-tile/glass-tile/': 'mosaic-tile',
  '/backsplash-tile/geometric-pattern/': 'mosaic-tile',
  '/backsplash-tile/bevollo-glass-tile/': 'mosaic-tile',
  '/backsplash-tile/rio-lago-pebbles-mosaics/': 'mosaic-tile',
  '/backsplash-tile/waterjet-cut-mosaics/': 'mosaic-tile',
  '/backsplash-tile/stik-wall-tile/': 'mosaic-tile',
  '/backsplash-tile/wood-look-wall-tile/': 'mosaic-tile',
  '/backsplash-tile/brickstaks/': 'mosaic-tile',
  '/backsplash-tile/acoustic-wood-slat/': 'mosaic-tile',
  '/backsplash-tile/stacked-stone-collection/': 'stacked-stone',
  '/backsplash-tile/encaustic-pattern/': 'mosaic-tile',
  '/backsplash-tile/luxor/': 'mosaic-tile',
  '/backsplash-tile/revaso-recycled-glass/': 'mosaic-tile',
  '/backsplash-tile/specialty-shapes-wall-tile/': 'mosaic-tile',
  '/mosaics/collections-mosaics/': 'mosaic-tile',
  '/fluted-looks/': 'mosaic-tile',
  '/hardscape/rockmount-stacked-stone/': 'stacked-stone',
  '/hardscape/arterra-porcelain-pavers/': 'hardscaping',
  '/evergrass-turf/': 'hardscaping',
};

// SKU prefix → accessory detection
const ACCESSORY_PREFIXES = ['VTT', 'TT'];
const TRIM_SUFFIX_MAP = {
  '-EC': 'End Cap', '-ECL': 'End Cap Long',
  '-FSN-EE': 'Flush Stair Nose', '-FSN': 'Flush Stair Nose', '-FSNL': 'Flush Stair Nose Long',
  '-OSN': 'Overlapping Stair Nose',
  '-QR': 'Quarter Round',
  '-SR': 'Reducer', '-SRL': 'Reducer Long',
  '-T': 'T-Molding', '-T-SR': 'T-Molding Reducer',
  '-ST-EE': 'Stair Tread', '-ST': 'Stair Tread',
  '-RT': 'Riser Tread',
  '-4-IN-1': '4-in-1 Transition',
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[${elapsed}s] ${msg}`);
}

let startTime = Date.now();

// ─── Puppeteer page helpers ──────────────────────────────────────────────────

async function collectProductUrls(browser, categoryUrl) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  try {
    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.new-filter-collection a, .bordered-image-filter a', { timeout: 15000 }).catch(() => {});

    // Click "Load More" repeatedly
    let previousCount = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const loadMoreBtn = await page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.find(a =>
          a.textContent.trim().toLowerCase().includes('load more') &&
          (a.href.includes('javascript:') || a.href === '' || a.getAttribute('href') === '#')
        ) || null;
      });
      const isElement = await loadMoreBtn.evaluate(el => el !== null).catch(() => false);
      if (!isElement) break;
      const isVisible = await loadMoreBtn.evaluate(el => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      }).catch(() => false);
      if (!isVisible) break;
      await loadMoreBtn.click().catch(() => {});
      await delay(2500);
      const currentCount = await page.$$eval('.new-filter-collection a[href]',
        els => els.filter(a => a.href && !a.href.includes('javascript:')).length
      ).catch(() => 0);
      if (currentCount <= previousCount) break;
      if (currentCount >= 500) break;
      previousCount = currentCount;
    }

    const baseHost = new URL(categoryUrl).origin;
    return await page.evaluate((baseHost) => {
      const seen = new Set();
      const results = [];
      function isValid(href) {
        if (!href || href.includes('javascript:') || href === '#') return false;
        try { if (new URL(href).origin !== baseHost) return false; } catch { return false; }
        if (/\.(pdf|jpg|png|gif|svg|mp4|zip)(\?|$)/i.test(href)) return false;
        if (href.includes('/site-search') || href.includes('?')) return false;
        if (href.includes('/corporate/') || href.includes('/news/') || href.includes('/blog/')) return false;
        const path = new URL(href).pathname.toLowerCase();
        if (/\/(colors|features|benefits|faq|resources|installation|maintenance|warranty|care|cleaning|about|videos?|gallery)\/?$/.test(path)) return false;
        return true;
      }
      document.querySelectorAll('.new-filter-collection a[href]').forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (href && href.startsWith('/')) href = baseHost + href;
        if (!isValid(href) || seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });
      if (results.length === 0) {
        document.querySelectorAll('a[href]').forEach(a => {
          let href = a.href || a.getAttribute('href');
          if (href && href.startsWith('/')) href = baseHost + href;
          if (!isValid(href) || seen.has(href)) return;
          const path = new URL(href).pathname;
          const segments = path.split('/').filter(Boolean);
          if (segments.length >= 2 && a.querySelector('img')) {
            seen.add(href);
            results.push(href);
          }
        });
      }
      return results.slice(0, 500);
    }, baseHost);
  } finally { await page.close(); }
}

async function collectSubProductUrls(browser, collectionUrl) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media', 'image'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  try {
    await page.goto(collectionUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(1000);
    const baseHost = new URL(collectionUrl).origin;
    const collPath = new URL(collectionUrl).pathname.replace(/\/$/, '');
    return await page.evaluate((baseHost, collPath) => {
      const seen = new Set();
      const results = [];
      document.querySelectorAll('a[href]').forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (!href || href.includes('javascript:') || href === '#') return;
        try {
          const url = new URL(href, baseHost);
          if (url.origin !== baseHost) return;
          const path = url.pathname.replace(/\/$/, '');
          if (!path.startsWith(collPath + '/')) return;
          const sub = path.slice(collPath.length + 1);
          if (!sub || sub.includes('/')) return;
          if (/\.(pdf|jpg|png)$/i.test(path)) return;
          if (/\/(colors|features|faq|gallery|videos?)\/?$/i.test(path)) return;
          const full = url.origin + path + '/';
          if (seen.has(full)) return;
          seen.add(full);
          results.push(full);
        } catch {}
      });
      return results;
    }, baseHost, collPath);
  } finally { await page.close(); }
}

async function scrapeProductPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  try {
    // Rate-limit retry
    for (let retries = 0; retries < 3; retries++) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const check = await page.evaluate(() => (document.title + ' ' + (document.body?.innerText?.slice(0, 200) || '')));
      if (!/too many requests|429|rate limit/i.test(check)) break;
      await delay(5000 * (retries + 1));
    }
    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});

    // Expand accordions
    await page.evaluate(() => {
      document.querySelectorAll('.accordion-header, .accordion-toggle-icon, [data-toggle="collapse"], button[aria-expanded="false"], a[data-toggle="collapse"]')
        .forEach(t => { try { t.click(); } catch {} });
      document.querySelectorAll('#item-sizes a, #productSizesAccordion a[data-toggle="tab"]')
        .forEach(t => { try { t.click(); } catch {} });
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show'); el.style.display = ''; el.style.height = 'auto';
      });
      document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('active', 'in', 'show'); el.style.display = '';
      });
    });
    await delay(800);

    const data = await page.evaluate(() => {
      const result = { name: '', skus: [], collection: '', description: '', attributes: {}, images: [] };

      // Product name
      const h1 = document.querySelector('h1');
      if (h1) {
        result.name = h1.textContent.trim()
          .replace(/[®™©]/g, '').replace(/\bTM\b/g, '').trim();
      }

      // SKU variants via ID# lines
      const seen = new Set();
      const SECTION_TYPE_MAP = {
        'tiles': 'tile', 'tile': 'tile', 'mosaics': 'mosaic', 'mosaic': 'mosaic',
        'decorative mosaics': 'mosaic', 'slabs': 'slab', 'accessories': 'accessory',
        'trim': 'trim', 'bullnose': 'trim', 'pavers': 'paver',
      };
      const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      let currentVariantType = null;
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        if (SECTION_TYPE_MAP[lineLower]) { currentVariantType = SECTION_TYPE_MAP[lineLower]; continue; }
        const idMatch = lines[i].match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
        if (!idMatch) continue;
        const code = idMatch[1].trim();
        if (code.length < 5 || seen.has(code)) continue;
        seen.add(code);
        let itemDesc = '';
        if (i > 0 && !lines[i-1].match(/^(ID#:|Finish:|ADD TO|TILES|ACCESSORIES|DECORATIVE)/i)) {
          itemDesc = lines[i-1];
        }
        let finish = '';
        for (let j = i+1; j < Math.min(i+3, lines.length); j++) {
          const fm = lines[j].match(/^Finish:\s*(.+)/i);
          if (fm) { finish = fm[1].trim(); break; }
        }
        const sizeMatch = itemDesc.match(/(\d+)\s*[xX×]\s*(\d+)/);
        result.skus.push({
          code, itemDesc, finish,
          size: sizeMatch ? sizeMatch[1] + 'x' + sizeMatch[2] : '',
          variant_type: currentVariantType
        });
      }

      // Specs from dt/dd
      const SPEC_MAP = {
        'primary color': 'color', 'primary color(s)': 'color',
        'style': 'style', 'tile type': 'material', 'material': 'material',
        'finish': 'finish', 'thickness': 'thickness', 'total thickness': 'thickness',
        'wear layer': 'wear_layer', 'wear layer thickness': 'wear_layer',
        'size': 'size', 'plank size': 'size', 'country of origin': 'country',
        'core type': 'core_type', 'installation method': 'installation_method',
        'edge type': 'edge_type', 'edge detail': 'edge_type',
        'shade variation': 'shade_variation', 'shade variations': 'shade_variation',
        'pei rating': 'pei_rating', 'dcof': 'dcof', 'species': 'species',
      };
      document.querySelectorAll('dt').forEach(dt => {
        const label = dt.textContent.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (!dd || dd.tagName !== 'DD') return;
        const value = dd.textContent.trim();
        if (!value) return;
        const slug = SPEC_MAP[label];
        if (slug && !result.attributes[slug]) result.attributes[slug] = value;
      });
      // Fallback: line-by-line specs
      if (Object.keys(result.attributes).length < 3) {
        for (let li = 0; li < lines.length - 1; li++) {
          const label = lines[li].toLowerCase();
          const slug = SPEC_MAP[label];
          if (slug && !result.attributes[slug]) {
            const value = lines[li + 1];
            if (value && value.length < 100 && !SPEC_MAP[value.toLowerCase()]) {
              result.attributes[slug] = value;
            }
          }
        }
      }

      // Collection from breadcrumb
      for (const bc of document.querySelectorAll('.breadcrumb a, nav[aria-label*="bread"] a')) {
        const text = bc.textContent.trim();
        if (text && text.length < 40 && text.length > 2 &&
            !text.toLowerCase().includes('home') && !text.toLowerCase().includes('tile') &&
            !text.toLowerCase().includes('flooring')) {
          result.collection = text; break;
        }
      }

      // Description
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const content = metaDesc.getAttribute('content');
        if (content && content.length > 20) result.description = content.trim();
      }

      // Images (og:image + gallery)
      const seenUrls = new Set();
      function addImg(src, trusted) {
        if (!src || result.images.length >= 8) return;
        try {
          const u = new URL(src, window.location.origin);
          if (seenUrls.has(u.href)) return;
          if (!u.href.includes('cdn.msisurfaces.com') && !u.href.includes('/files/')) return;
          if (/\.(svg|gif|ico)(\?|$)/i.test(u.href)) return;
          if (/icon|logo|badge|placeholder|miscellaneous|thumbnails|flyers|brochures|roomvo/i.test(u.href)) return;
          seenUrls.add(u.href);
          result.images.push({ url: u.href, type: result.images.length === 0 ? 'primary' : 'alternate' });
        } catch {}
      }
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg) addImg(ogImg.getAttribute('content'), true);
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(script.textContent);
          const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
          imgs.forEach(u => addImg(u, true));
        } catch {}
      }
      document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
        addImg(img.src, false);
        addImg(img.getAttribute('data-src'), false);
      });

      return result;
    });

    // Post-process: clean names
    if (data.name) {
      data.name = data.name
        .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)(\s+\w+)?\s+(Tiles?|Planks?|Flooring|Slabs?|Stones?)\s*$/i, '')
        .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)\s*$/i, '')
        .replace(/\s+Wood\s+(?:Look\s+)?(?:Tiles?|Wall)\s*$/i, '')
        .replace(/\s+(?:Tiles?|Planks?|Flooring)\s*$/i, '')
        .replace(/\s+(Luxury Vinyl Planks?|Luxury Vinyl|Vinyl Planks?|LVP|LVT|SPC)\s*$/i, '')
        .replace(/\s+(Engineered Hardwood|Solid Hardwood|Hardwood)\s*$/i, '')
        .replace(/\s+Hybrid\s+Rigid\s+Core\s*$/i, '')
        .replace(/\s+(Collection|Series)\s*$/i, '')
        .trim();
    }
    if (data.collection) {
      data.collection = data.collection.replace(/[®™©]/g, '').replace(/\bTM\b/g, '')
        .replace(/\s+(Collection|Series)\s*$/i, '').trim();
      if (data.collection.length > 3 && data.collection === data.collection.toUpperCase()) {
        data.collection = data.collection.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    // Strip collection prefix from name
    if (data.collection && data.name) {
      const cl = data.collection.toLowerCase();
      const nl = data.name.toLowerCase();
      if (nl.startsWith(cl + ' ')) data.name = data.name.slice(data.collection.length).trim();
      if (nl === cl) data.collection = '';
    }

    return data;
  } finally { await page.close(); }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function getOrCreateProduct(vendorId, categoryId, collection, name, description) {
  // Check if product already exists
  const existing = await pool.query(
    `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 LIMIT 1`,
    [vendorId, collection || '', name]
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id, created: false };

  if (DRY_RUN) return { id: 'dry-run', created: true };

  const { rows: [p] } = await pool.query(`
    INSERT INTO products (vendor_id, category_id, collection, name, description_short, description_long, status, is_active, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'active', true, NOW(), NOW())
    ON CONFLICT (vendor_id, collection, name) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [vendorId, categoryId, collection || '', name,
      description ? description.slice(0, 255) : null,
      description || null]);
  return { id: p.id, created: true };
}

async function getOrCreateSku(productId, vendorId, vendorSku, internalSku, variantName, variantType, color, sellBy) {
  const existing = await pool.query(
    `SELECT id FROM skus WHERE internal_sku = $1 LIMIT 1`, [internalSku]
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id, created: false };

  if (DRY_RUN) return { id: 'dry-run', created: true };

  const { rows: [s] } = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, variant_type, color, sell_by, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
    ON CONFLICT (internal_sku) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [productId, vendorSku, internalSku, variantName, variantType, color, sellBy]);
  return { id: s.id, created: true };
}

async function saveImageUrl(productId, skuId, imageUrl, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW(), NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, imageUrl, sortOrder]);
}

async function saveAttribute(skuId, slug, value) {
  if (DRY_RUN || !value) return;
  // Get or create attribute
  let { rows } = await pool.query(`SELECT id FROM attributes WHERE slug = $1`, [slug]);
  let attrId;
  if (rows.length > 0) {
    attrId = rows[0].id;
  } else {
    const { rows: [a] } = await pool.query(
      `INSERT INTO attributes (name, slug, data_type, created_at, updated_at) VALUES ($1, $2, 'text', NOW(), NOW()) ON CONFLICT (slug) DO UPDATE SET updated_at = NOW() RETURNING id`,
      [slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), slug]
    );
    attrId = a.id;
  }
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value, created_at) VALUES ($1, $2, $3, NOW())
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attrId, value]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  startTime = Date.now();
  log(`MSI Recovery — Web Scrape${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log('═'.repeat(60));

  // Get vendor + category IDs
  const { rows: [vendor] } = await pool.query(`SELECT id FROM vendors WHERE code = 'MSI'`);
  if (!vendor) { log('ERROR: MSI vendor not found'); return; }
  const vendorId = vendor.id;

  const catCache = {};
  const { rows: cats } = await pool.query(`SELECT id, slug FROM categories`);
  for (const c of cats) catCache[c.slug] = c.id;

  const activeCats = ONLY_CAT
    ? CATEGORIES.filter(c => c.includes(ONLY_CAT))
    : CATEGORIES;

  log(`Scraping ${activeCats.length} categories...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const visitedUrls = new Set();
    let totalProducts = 0, totalSkus = 0, totalImages = 0;
    let productsCreated = 0, skusCreated = 0;

    for (const categoryPath of activeCats) {
      const categoryUrl = BASE_URL + categoryPath;
      const categorySlug = CATEGORY_MAP[categoryPath] || null;
      const categoryId = categorySlug ? (catCache[categorySlug] || null) : null;

      log(`\nCategory: ${categoryPath} → ${categorySlug || 'unmapped'}`);

      let productUrls;
      try {
        productUrls = await collectProductUrls(browser, categoryUrl);
        log(`  Found ${productUrls.length} product links`);
      } catch (err) {
        log(`  ERROR collecting URLs: ${err.message}`);
        continue;
      }

      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];
        const norm = url.replace(/\/$/, '').toLowerCase();
        if (visitedUrls.has(norm)) continue;
        visitedUrls.add(norm);

        try {
          const data = await scrapeProductPage(browser, url);
          if (!data || !data.name) continue;

          // Skip non-product pages
          const nameLower = data.name.toLowerCase();
          if (/too many requests|care & maintenance|brochure|videos|countertop|tub and shower|shower panel|putting green/i.test(nameLower)) continue;
          if (/^(mosaic tile|glass tile|encaustic tile)$/i.test(data.name)) continue;

          // Need real SKU codes (with digits)
          const hasRealSku = data.skus && data.skus.some(s => /\d/.test(s.code));
          if (!hasRealSku) {
            // Try drill-down
            try {
              const subUrls = await collectSubProductUrls(browser, url);
              if (subUrls.length > 0) {
                log(`  Collection "${data.name}" → ${subUrls.length} sub-products`);
                productUrls.splice(i + 1, 0, ...subUrls);
              }
            } catch {}
            continue;
          }

          // Determine sell_by from category
          const sellBy = ['lvp-plank', 'engineered-hardwood', 'waterproof-wood', 'porcelain-tile', 'natural-stone', 'mosaic-tile'].includes(categorySlug) ? 'sqft' : 'unit';

          // Create product
          const collection = data.collection || '';
          const productResult = await getOrCreateProduct(vendorId, categoryId, collection, data.name, data.description);
          if (productResult.created) productsCreated++;
          totalProducts++;
          const productId = productResult.id;

          // Create SKUs
          for (const sku of data.skus) {
            if (!/\d/.test(sku.code)) continue;
            const vendorSku = sku.code.toUpperCase();
            const internalSku = `MSI-${vendorSku}`;
            const isAcc = ACCESSORY_PREFIXES.some(p => vendorSku.startsWith(p)) || sku.variant_type === 'accessory' || sku.variant_type === 'trim';

            // Determine variant name
            let variantName = sku.itemDesc || sku.size || vendorSku;
            if (isAcc) {
              // Try trim suffix
              const suffixes = Object.keys(TRIM_SUFFIX_MAP).sort((a, b) => b.length - a.length);
              for (const suffix of suffixes) {
                if (vendorSku.endsWith(suffix.replace(/-/g, ''))) {
                  variantName = TRIM_SUFFIX_MAP[suffix]; break;
                }
                if (vendorSku.endsWith(suffix)) {
                  variantName = TRIM_SUFFIX_MAP[suffix]; break;
                }
              }
            }

            const skuResult = await getOrCreateSku(
              productId, vendorId, vendorSku, internalSku,
              variantName, isAcc ? 'accessory' : null,
              data.attributes.color || null, isAcc ? 'unit' : sellBy
            );
            if (skuResult.created) skusCreated++;
            totalSkus++;

            // Save attributes
            for (const [slug, value] of Object.entries(data.attributes)) {
              await saveAttribute(skuResult.id, slug, value);
            }
            if (sku.size) await saveAttribute(skuResult.id, 'size', sku.size);
            if (sku.finish) await saveAttribute(skuResult.id, 'finish', sku.finish);
          }

          // Save images (product-level)
          for (let imgIdx = 0; imgIdx < data.images.length; imgIdx++) {
            await saveImageUrl(productId, null, data.images[imgIdx].url, data.images[imgIdx].type, imgIdx);
            totalImages++;
          }

          if ((i + 1) % 10 === 0) {
            log(`  Progress: ${i + 1}/${productUrls.length} — ${productsCreated} new products, ${skusCreated} new SKUs`);
          }

        } catch (err) {
          log(`  ERROR scraping ${url}: ${err.message}`);
        }
        await delay(DELAY_MS);
      }
    }

    log('\n' + '═'.repeat(60));
    log(`RECOVERY COMPLETE${DRY_RUN ? ' (DRY RUN)' : ''}`);
    log(`  Products visited: ${totalProducts}`);
    log(`  Products created: ${productsCreated}`);
    log(`  SKUs created:     ${skusCreated}`);
    log(`  Images saved:     ${totalImages}`);
    log(`  Total time:       ${((Date.now() - startTime) / 60000).toFixed(1)} minutes`);

  } finally {
    if (browser) await browser.close();
    await pool.end();
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
