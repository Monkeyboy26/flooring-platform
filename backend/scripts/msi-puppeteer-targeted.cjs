#!/usr/bin/env node
/**
 * MSI Targeted Puppeteer — Visit MSI product pages to find correct images
 * for the remaining 49 products without images.
 *
 * Strategy: Construct MSI website URLs from product names and scrape with Puppeteer.
 * MSI renders all content via JavaScript so we need full browser rendering.
 */
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extract series and color from display name
function parseProductName(displayName) {
  const name = displayName.trim();

  // Known multi-word series
  const multiWordSeries = [
    'Chateau Luna', 'Kaya Onda', 'Traktion Stowe', 'Traktion Maven', 'Traktion Calypso',
    'Carolina Timber', 'Hd Blume', 'Hd Toucan', 'Gold Green', 'Hawaiian Sky',
    'Dune Silk', 'New Diana', 'Regallo Marquinanoir', 'Regallo Midnight',
    'Traktion Stowe', 'Snowdrift White', 'Thundercloud Grey', 'Travertino White',
    'Seashell Bianco', 'Village Tildes'
  ];

  for (const ms of multiWordSeries) {
    if (name.startsWith(ms)) {
      return {
        series: ms,
        color: name.slice(ms.length).trim()
          .replace(/\s+(Matte|Polished|Glossy|Honed|Lappato|Satin|R11|R10|R9)\s*.*$/i, '')
          .replace(/\s+\d{4}\s*/g, '')
          .replace(/\s+(Bullnose|Mosaic|3d)\s*.*$/i, '')
          .trim(),
        finish: (name.match(/(Matte|Polished|Glossy|Honed|Lappato|Satin)/i) || [])[1] || '',
        fullClean: name.replace(/\s+\d{4}/g, '').replace(/\s+(Bullnose|Mosaic|3d)\s*.*$/i, '').trim()
      };
    }
  }

  // Single-word series (most common)
  const words = name.split(/\s+/);
  const series = words[0];
  const rest = words.slice(1).join(' ');
  const color = rest
    .replace(/\s+(Matte|Polished|Glossy|Honed|Lappato|Satin|R11|R10|R9)\s*.*$/i, '')
    .replace(/\s+\d{4}\s*/g, '')
    .replace(/\s+(Bullnose|Mosaic|3d)\s*.*$/i, '')
    .replace(/x\d+mm\s*$/i, '')
    .replace(/x\.\d+.*$/i, '')
    .replace(/x\.50.*$/i, '')
    .replace(/Realex.*$/i, '')
    .trim();

  return {
    series,
    color,
    finish: (name.match(/(Matte|Polished|Glossy|Honed|Lappato|Satin)/i) || [])[1] || '',
    fullClean: name.replace(/\s+\d{4}/g, '').replace(/\s+(Bullnose|Mosaic|3d)\s*.*$/i, '').trim()
  };
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Generate URL candidates for a product
function generateUrls(parsed) {
  const urls = [];
  const seriesSlug = slugify(parsed.series);
  const colorSlug = slugify(parsed.color);
  const fullSlug = slugify(parsed.fullClean);

  // Category paths
  const categories = [
    'porcelain-tile', 'ceramic-tile', 'natural-stone-tile',
    'mosaic-tile', 'luxury-vinyl-tile'
  ];

  const base = 'https://www.msisurfaces.com';

  for (const cat of categories) {
    // Series page (often has all colors)
    urls.push(`${base}/${cat}/${seriesSlug}/`);

    if (colorSlug) {
      // Series + color
      urls.push(`${base}/${cat}/${seriesSlug}-${colorSlug}/`);
      // Color as sub-path
      urls.push(`${base}/${cat}/${seriesSlug}/${colorSlug}/`);
      // Full slug
      urls.push(`${base}/${cat}/${fullSlug}/`);
      // Color + series reversed
      urls.push(`${base}/${cat}/${colorSlug}-${seriesSlug}/`);
    }
  }

  // Deduplicate
  return [...new Set(urls)];
}

// Generate CDN URL candidates
function generateCdnUrls(parsed) {
  const urls = [];
  const seriesSlug = slugify(parsed.series);
  const colorSlug = slugify(parsed.color);
  const fullSlug = slugify(parsed.fullClean);
  const finishSlug = slugify(parsed.finish);

  const CDN = 'https://cdn.msisurfaces.com/images';
  const sections = ['porcelainceramic', 'colornames', 'naturalstone', 'mosaics', 'hardscaping', 'lvt'];
  const types = ['iso', 'detail', 'colornames', 'front'];

  for (const section of sections) {
    for (const type of types) {
      // Standard patterns
      urls.push(`${CDN}/${section}/${type}/${seriesSlug}-${colorSlug}-iso.jpg`);
      urls.push(`${CDN}/${section}/${type}/${seriesSlug}-${colorSlug}.jpg`);
      urls.push(`${CDN}/${section}/${type}/${colorSlug}-${seriesSlug}.jpg`);
      urls.push(`${CDN}/${section}/${type}/${fullSlug}.jpg`);
      urls.push(`${CDN}/${section}/${type}/${fullSlug}-iso.jpg`);

      if (finishSlug) {
        urls.push(`${CDN}/${section}/${type}/${seriesSlug}-${colorSlug}-${finishSlug}.jpg`);
        urls.push(`${CDN}/${section}/${type}/${colorSlug}-${finishSlug}-${seriesSlug}.jpg`);
        urls.push(`${CDN}/${section}/${type}/${seriesSlug}-${colorSlug}-porcelain.jpg`);
      }
    }
    // Root level
    urls.push(`${CDN}/${section}/${seriesSlug}-${colorSlug}.jpg`);
    urls.push(`${CDN}/${section}/${seriesSlug}-${colorSlug}-porcelain.jpg`);
    urls.push(`${CDN}/${section}/${fullSlug}.jpg`);
  }

  return [...new Set(urls)];
}

async function headUrl(url) {
  const https = require('https');
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

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

  let matched = 0;
  const needsImage = new Set(missing.map(m => m.id));

  // === Phase 1: CDN Probe with better slug patterns ===
  console.log('=== Phase 1: CDN Probe ===');
  let probed = 0;

  for (const m of missing) {
    if (!needsImage.has(m.id)) continue;
    const parsed = parseProductName(m.display_name);
    const cdnUrls = generateCdnUrls(parsed);

    let found = false;
    for (const url of cdnUrls) {
      probed++;
      const result = await headUrl(url);
      if (result) {
        const saved = await saveImage(m.id, result);
        if (saved) {
          matched++;
          needsImage.delete(m.id);
          console.log(`  CDN: ${m.display_name} → ${result}`);
          found = true;
          break;
        }
      }
    }
    if (!found && probed % 200 === 0) {
      process.stdout.write(`  probed ${probed}...\r`);
    }
  }
  console.log(`CDN phase: ${matched} found from ${probed} probes\n`);

  if (needsImage.size === 0) {
    console.log('All done!');
    await printStats(vid);
    await pool.end();
    return;
  }

  // === Phase 2: Puppeteer - Visit MSI website ===
  console.log(`=== Phase 2: Puppeteer (${needsImage.size} remaining) ===`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Block unnecessary resources
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  let puppeteerMatched = 0;
  const visitedUrls = new Set();

  for (const m of missing) {
    if (!needsImage.has(m.id)) continue;
    const parsed = parseProductName(m.display_name);
    const urls = generateUrls(parsed);

    let found = false;
    for (const url of urls) {
      if (visitedUrls.has(url)) continue;
      visitedUrls.add(url);

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (!response || response.status() !== 200) continue;

        // Wait for JS rendering
        await delay(3000);

        // Extract images from the page
        const images = await page.evaluate(() => {
          const imgs = [];

          // Try og:image first
          const ogImg = document.querySelector('meta[property="og:image"]');
          if (ogImg && ogImg.content && !ogImg.content.includes('default') && !ogImg.content.includes('logo')) {
            imgs.push(ogImg.content);
          }

          // Try JSON-LD
          const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const s of ldScripts) {
            try {
              const data = JSON.parse(s.textContent);
              if (data.image) {
                const imgArr = Array.isArray(data.image) ? data.image : [data.image];
                for (const img of imgArr) {
                  if (typeof img === 'string') imgs.push(img);
                  else if (img.url) imgs.push(img.url);
                }
              }
            } catch {}
          }

          // Try gallery images
          const galleryImgs = document.querySelectorAll('.product-gallery img, .pdp-gallery img, .product-image img, .hero-image img, [class*="product"] img');
          for (const img of galleryImgs) {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy');
            if (src && src.includes('msisurfaces.com') && !src.includes('svg') && !src.includes('logo') && !src.includes('icon')) {
              imgs.push(src);
            }
          }

          // Try all large CDN images on the page
          const allImgs = document.querySelectorAll('img');
          for (const img of allImgs) {
            const src = img.src || img.getAttribute('data-src');
            if (src && src.includes('cdn.msisurfaces.com') && !src.includes('svg') && !src.includes('logo') && !src.includes('icon') && !src.includes('thumbnail')) {
              imgs.push(src);
            }
          }

          return [...new Set(imgs)].filter(u => u && (u.endsWith('.jpg') || u.endsWith('.png') || u.endsWith('.webp')));
        });

        if (images.length > 0) {
          // Save primary image
          const saved = await saveImage(m.id, images[0], 'primary', 0);
          if (saved) {
            puppeteerMatched++;
            needsImage.delete(m.id);
            console.log(`  Puppeteer: ${m.display_name} → ${images[0]}`);

            // Save additional images
            for (let i = 1; i < Math.min(images.length, 4); i++) {
              const type = i === 1 ? 'alternate' : (i === 2 ? 'lifestyle' : 'alternate');
              await saveImage(m.id, images[i], type, i);
            }
            found = true;
            break;
          }
        }
      } catch (err) {
        // Page load error, try next URL
      }
    }

    if (!found) {
      console.log(`  Miss: ${m.display_name}`);
    }
  }

  await browser.close();
  console.log(`\nPuppeteer phase: ${puppeteerMatched} found\n`);

  // === Phase 3: Series-based sharing from CORRECT images only ===
  // For remaining products, find a sibling in the same series that has CORRECT images
  // (URL must contain the series name)
  if (needsImage.size > 0) {
    console.log(`=== Phase 3: Series sharing (${needsImage.size} remaining) ===`);
    let seriesMatched = 0;

    for (const m of missing) {
      if (!needsImage.has(m.id)) continue;
      const parsed = parseProductName(m.display_name);
      const seriesLower = parsed.series.toLowerCase();

      if (seriesLower.length < 4) continue;
      // Skip generic series
      if (['gold', 'new', 'hd'].includes(seriesLower)) continue;

      // Find sibling with matching series AND correct image (URL contains series name)
      const { rows: donors } = await pool.query(`
        SELECT p.id, p.display_name, ma.url, ma.asset_type, ma.sort_order
        FROM products p
        JOIN media_assets ma ON ma.product_id = p.id
        WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
          AND lower(p.display_name) LIKE lower($2) || '%'
          AND lower(ma.url) LIKE '%' || lower($2) || '%'
        ORDER BY
          CASE WHEN lower(p.display_name) LIKE lower($3) || '%' THEN 0 ELSE 1 END,
          ma.sort_order
        LIMIT 5
      `, [vid, parsed.series, parsed.series + ' ' + parsed.color]);

      if (donors.length > 0) {
        const primary = donors[0];
        const saved = await saveImage(m.id, primary.url, 'primary', 0);
        if (saved) {
          seriesMatched++;
          needsImage.delete(m.id);
          console.log(`  Series: ${m.display_name} → ${primary.url} (from ${donors[0].display_name})`);

          // Copy additional images from same donor product
          const donorId = donors[0].id;
          for (let i = 1; i < donors.length && donors[i].id === donorId; i++) {
            await saveImage(m.id, donors[i].url, donors[i].asset_type, donors[i].sort_order);
          }
        }
      }
    }
    console.log(`Series sharing: ${seriesMatched} matched\n`);
  }

  // Print final stats
  await printStats(vid);

  // List remaining
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

async function printStats(vid) {
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
}
