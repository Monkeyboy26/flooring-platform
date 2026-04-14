#!/usr/bin/env node
/**
 * MSI Page Probe — Visit actual MSI product pages for the 49 missing products.
 * Uses networkidle2 + longer waits for full JS rendering.
 * Constructs URLs based on known MSI URL patterns.
 */
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Product name -> URL slug mappings for MSI website
const SERIES_URLS = {
  // Porcelain tile series
  'bellataj': '/porcelain-tile/bellataj/',
  'chateau luna': '/porcelain-tile/chateau-luna/',
  'flamenco': '/backsplash-tile/specialty-shapes-wall-tile/',  // Wall tile, in backsplash
  'regallo': '/porcelain-tile/regallo/',
  'murcia': '/porcelain-tile/murcia/',
  'traktion': '/porcelain-tile/traktion/',
  'kaya onda': '/porcelain-tile/kaya-onda/',
  'mattonella': '/porcelain-tile/mattonella/',
  'terranello': '/porcelain-tile/terranello/',
  'valgrande': '/porcelain-tile/valgrande/',
  'village': '/backsplash-tile/encaustic-pattern/',
  'carolina timber': '/wood-look-tile-and-planks/',
  'alura': '/porcelain-tile/alura/',
  'cristaline': '/porcelain-tile/cristaline/',
  'dune silk': '/porcelain-tile/dune-silk/',
  'hd blume': '/porcelain-tile/hd-blume/',
  'hd toucan': '/porcelain-tile/hd-toucan/',
  'seashell': '/porcelain-tile/seashell/',
  'snowdrift': '/porcelain-tile/snowdrift/',
  'thundercloud': '/porcelain-tile/thundercloud/',
  'travertino': '/porcelain-tile/travertino/',
  // Natural stone
  'chiaro': '/travertine-tile/chiaro/',
  'gold green': '/slate-tile/',
  'new diana reale': '/marble-tile/new-diana-reale/',
  // Mosaics
  'ayres': '/mosaics/collections-mosaics/',
  'hawaiian sky': '/mosaics/collections-mosaics/',
};

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name, c.name as category
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ORDER BY c.name, p.display_name
  `, [vid]);
  console.log(`Missing: ${missing.length} products\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let matched = 0;
  const needsImage = new Set(missing.map(m => m.id));

  // Group by series for efficient browsing
  const seriesGroups = new Map();
  for (const m of missing) {
    const words = m.display_name.split(/\s+/);
    // Try known multi-word series
    let series = null;
    for (const key of Object.keys(SERIES_URLS)) {
      if (m.display_name.toLowerCase().startsWith(key)) {
        series = key;
        break;
      }
    }
    if (!series) series = words[0].toLowerCase();
    if (!seriesGroups.has(series)) seriesGroups.set(series, []);
    seriesGroups.get(series).push(m);
  }

  for (const [series, products] of seriesGroups) {
    if (products.every(p => !needsImage.has(p.id))) continue;

    console.log(`\n--- Series: ${series} (${products.length} products) ---`);

    // Construct URLs to try
    const urlsToTry = [];
    const seriesSlug = slugify(series);

    // Known URL if exists
    if (SERIES_URLS[series]) {
      urlsToTry.push(`https://www.msisurfaces.com${SERIES_URLS[series]}`);
    }

    // Common patterns
    const categories = ['porcelain-tile', 'ceramic-tile', 'natural-stone-tile', 'mosaic-tile',
      'marble-tile', 'travertine-tile', 'slate-tile', 'wood-look-tile-and-planks'];
    for (const cat of categories) {
      urlsToTry.push(`https://www.msisurfaces.com/${cat}/${seriesSlug}/`);
    }

    // Also try direct product URLs for each color
    for (const p of products) {
      const parsed = p.display_name.toLowerCase()
        .replace(/\s+\d{4}/g, '')
        .replace(/\s+(matte|polished|glossy|honed|lappato|satin|r11|r10|r9)\s*$/i, '')
        .replace(/\s+(bullnose|mosaic|3d)\s*$/i, '')
        .replace(/x\d+mm$/i, '')
        .replace(/x\.\d+.*$/i, '')
        .trim();
      const fullSlug = slugify(parsed);
      for (const cat of categories.slice(0, 3)) {
        urlsToTry.push(`https://www.msisurfaces.com/${cat}/${fullSlug}/`);
      }
    }

    // Deduplicate
    const uniqueUrls = [...new Set(urlsToTry)];
    const visitedImages = new Map(); // url -> { images, title }

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    for (const url of uniqueUrls) {
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
        if (!response || response.status() !== 200) continue;

        // Wait for full JS rendering
        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
        await delay(2000);

        const pageData = await page.evaluate(() => {
          const result = { title: '', images: [], productLinks: [] };

          // Get page title
          const h1 = document.querySelector('h1');
          result.title = h1 ? h1.textContent.trim() : '';

          // 1. og:image
          const ogImg = document.querySelector('meta[property="og:image"]');
          if (ogImg && ogImg.content && !ogImg.content.includes('default') && !ogImg.content.includes('logo') && !ogImg.content.includes('svg')) {
            result.images.push(ogImg.content);
          }

          // 2. JSON-LD
          for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const d = JSON.parse(s.textContent);
              if (d.image) {
                const ia = Array.isArray(d.image) ? d.image : [d.image];
                ia.forEach(u => { if (typeof u === 'string' && !u.includes('svg')) result.images.push(u); });
              }
            } catch {}
          }

          // 3. CDN images on the page
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy');
            if (src && src.includes('cdn.msisurfaces.com') && !src.includes('svg') && !src.includes('logo')
                && !src.includes('icon') && !src.includes('cart') && !src.includes('thumbnail')
                && (src.endsWith('.jpg') || src.endsWith('.png') || src.endsWith('.webp'))) {
              result.images.push(src);
            }
          });

          // 4. Product links (for series pages with color variants)
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            if (href && href.includes('msisurfaces.com') && !href.includes('site-search')) {
              const img = a.querySelector('img');
              if (img) {
                const imgSrc = img.src || img.getAttribute('data-src');
                if (imgSrc && imgSrc.includes('cdn.msisurfaces.com') && !imgSrc.includes('svg')) {
                  const title = a.textContent.trim().replace(/\s+/g, ' ').substring(0, 100);
                  result.productLinks.push({ href, image: imgSrc, title });
                }
              }
            }
          });

          result.images = [...new Set(result.images)];
          return result;
        });

        if (pageData.images.length > 0 || pageData.productLinks.length > 0) {
          console.log(`  Page: ${url}`);
          console.log(`    Title: ${pageData.title}`);
          console.log(`    Images: ${pageData.images.length}, Links: ${pageData.productLinks.length}`);

          // If this is a series page with product links, match products by color
          if (pageData.productLinks.length > 0) {
            for (const p of products) {
              if (!needsImage.has(p.id)) continue;
              const pLower = p.display_name.toLowerCase();

              // Find the link whose title best matches this product
              for (const link of pageData.productLinks) {
                const linkTitle = link.title.toLowerCase();
                const linkUrl = link.href.toLowerCase();

                // Check if the product color appears in the link
                const color = pLower.replace(series, '').replace(/\d{4}/g, '')
                  .replace(/(matte|polished|glossy|honed|lappato|satin|r11|bullnose|mosaic|3d)/gi, '')
                  .trim();

                if (color.length >= 3 && (linkTitle.includes(color) || linkUrl.includes(slugify(color)))) {
                  await saveImage(p.id, link.image);
                  matched++;
                  needsImage.delete(p.id);
                  console.log(`    ✓ ${p.display_name} → ${link.image} (via link: ${link.title.substring(0, 50)})`);
                  break;
                }
              }
            }
          }

          // If we got direct page images and haven't matched products yet
          if (pageData.images.length > 0) {
            for (const p of products) {
              if (!needsImage.has(p.id)) continue;

              // For a series page with a single image, assign to all products in series
              // But verify the image URL contains at least part of the series name
              const imgUrl = pageData.images[0].toLowerCase();
              if (imgUrl.includes(seriesSlug) ||
                  imgUrl.includes(slugify(pageData.title)) ||
                  pageData.title.toLowerCase().includes(series)) {
                await saveImage(p.id, pageData.images[0]);
                matched++;
                needsImage.delete(p.id);
                console.log(`    ✓ ${p.display_name} → ${pageData.images[0]} (series page)`);
              }
            }
          }
        }
      } catch (err) {
        // Skip failed URLs
      }
    }

    await page.close();
    await delay(1500);
  }

  await browser.close();

  console.log(`\n\nTotal matched: ${matched}`);

  // Final coverage
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);

  if (needsImage.size > 0) {
    console.log(`\nStill missing (${needsImage.size}):`);
    for (const m of missing) {
      if (needsImage.has(m.id)) {
        console.log(`  [${m.category}] ${m.display_name}`);
      }
    }
  }

  await pool.end();
})();

async function saveImage(productId, url, assetType = 'primary', sortOrder = 0) {
  try {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, $2, $3, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    `, [productId, assetType, url, sortOrder]);
    return true;
  } catch {
    return false;
  }
}
