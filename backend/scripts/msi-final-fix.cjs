#!/usr/bin/env node
/**
 * MSI Final Fix — Comprehensive image assignment for all remaining products.
 *
 * Phase 1: Smart series sharing — share images from correct siblings (local uploads preferred)
 * Phase 2: Puppeteer scrape of MSI website for unique series pages
 * Phase 3: Best-effort CDN probing with color-only slugs
 * Phase 4: Delete verified-wrong images (word-matcher artifacts)
 */
const { Pool } = require('pg');
const puppeteer = require('puppeteer');
const https = require('https');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function headUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
  } catch { return false; }
}

// Known multi-word series (longest first for matching)
const MULTI_SERIES = [
  'Chateau Luna', 'Kaya Onda', 'Kaya Zermatta', 'Kaya Calacatta',
  'Traktion Stowe', 'Traktion Maven', 'Traktion Calypso',
  'Carolina Timber', 'New Diana',
  'Regallo Calacatta Marbella', 'Regallo Calacatta Isla',
  'Regallo Marquina Noir', 'Regallo Midnight Agate', 'Regallo Marquinanoir',
  'Snowdrift White', 'Thundercloud Grey', 'Travertino White',
  'Seashell Bianco', 'Dune Silk', 'Gold Green', 'Hawaiian Sky',
  'Hd Blume', 'Hd Toucan', 'Hd Aura',
];

function getSeries(name) {
  const lower = name.toLowerCase();
  for (const ms of MULTI_SERIES) {
    if (lower.startsWith(ms.toLowerCase())) return ms;
  }
  return name.split(/\s+/)[0];
}

function getColor(name, series) {
  return name.slice(series.length).trim()
    .replace(/\s+\d{4}\s*/g, ' ')
    .replace(/\s+(Matte|Polished|Glossy|Honed|Lappato|Satin|R11|R10|R9)\s*.*$/i, '')
    .replace(/\s+(Bullnose|Bn|Mosaic|3d|Crown Molding|Coping|Paver)\s*.*$/i, '')
    .replace(/x\d+mm\s*$/i, '')
    .replace(/x\.\d+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name, c.name as category
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ORDER BY p.display_name
  `, [vid]);
  console.log(`Missing: ${missing.length} products\n`);

  const needsImage = new Set(missing.map(m => m.id));
  let totalMatched = 0;

  // ===== Phase 1: Smart Series Sharing =====
  console.log('=== Phase 1: Smart series sharing ===');

  // For each missing product, find same-series sibling with CORRECT images
  // Priority: 1) same color from local uploads, 2) same color from CDN, 3) any color from local, 4) any correct CDN

  for (const m of missing) {
    if (!needsImage.has(m.id)) continue;

    const series = getSeries(m.display_name);
    const color = getColor(m.display_name, series);
    const seriesLower = series.toLowerCase();

    if (seriesLower.length < 4) continue;
    // Skip ultra-generic series names
    if (['gold', 'new', 'blue'].includes(seriesLower)) continue;

    // Find best matching sibling
    // 1) Same series + same color, local upload image (best quality)
    // 2) Same series + same color, CDN image with series name in URL
    // 3) Same series, any color, local upload image
    // 4) Same series, any color, CDN image with series name in URL
    const { rows: siblings } = await pool.query(`
      SELECT p.id, p.display_name, ma.url, ma.asset_type, ma.sort_order,
        CASE WHEN ma.url LIKE '/uploads/%' THEN 1 ELSE 0 END as is_local,
        CASE WHEN lower(p.display_name) LIKE lower($3) || '%' THEN 1 ELSE 0 END as color_match
      FROM products p
      JOIN vendors v2 ON p.vendor_id = v2.id
      JOIN media_assets ma ON ma.product_id = p.id AND ma.sort_order = 0
      WHERE v2.code = 'MSI' AND p.status = 'active' AND p.is_active = true
        AND lower(p.display_name) LIKE lower($1) || '%'
        AND p.id != $2
        AND (ma.url LIKE '/uploads/%' OR lower(ma.url) LIKE '%' || lower($1) || '%')
      ORDER BY color_match DESC, is_local DESC, ma.sort_order ASC
      LIMIT 1
    `, [series, m.id, series + ' ' + color]);

    if (siblings.length > 0) {
      const donor = siblings[0];
      const saved = await saveImage(m.id, donor.url);
      if (saved) {
        totalMatched++;
        needsImage.delete(m.id);
        console.log(`  ✓ ${m.display_name} → ${donor.display_name} (${donor.url.startsWith('/') ? 'local' : 'CDN'})`);
      }
    }
  }

  console.log(`Phase 1: ${totalMatched} matched\n`);

  // ===== Phase 2: Puppeteer for unique series pages =====
  const remaining = missing.filter(m => needsImage.has(m.id));
  if (remaining.length > 0) {
    console.log(`=== Phase 2: Puppeteer (${remaining.length} remaining) ===`);

    // Group by series and deduplicate
    const seriesToVisit = new Map();
    for (const m of remaining) {
      const series = getSeries(m.display_name);
      const seriesSlug = slugify(series);
      if (!seriesToVisit.has(seriesSlug)) seriesToVisit.set(seriesSlug, { series, products: [] });
      seriesToVisit.get(seriesSlug).products.push(m);
    }

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    let puppeteerMatched = 0;
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    for (const [seriesSlug, { series, products }] of seriesToVisit) {
      if (products.every(p => !needsImage.has(p.id))) continue;

      // Try porcelain-tile first since most are porcelain
      const categories = ['porcelain-tile', 'ceramic-tile', 'marble-tile', 'natural-stone-tile', 'mosaic-tile'];
      let foundOnPage = false;

      for (const cat of categories) {
        if (foundOnPage) break;
        const url = `https://www.msisurfaces.com/${cat}/${seriesSlug}/`;

        try {
          const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
          if (!resp || resp.status() !== 200) continue;
          await delay(2000);

          const pageImages = await page.evaluate(() => {
            const imgs = new Map();

            // og:image
            const og = document.querySelector('meta[property="og:image"]');
            if (og && og.content && !og.content.includes('svg') && !og.content.includes('logo')) {
              imgs.set('_og', og.content);
            }

            // Product link cards with images (series landing pages)
            document.querySelectorAll('a[href]').forEach(a => {
              const img = a.querySelector('img');
              if (!img) return;
              const src = img.src || img.getAttribute('data-src');
              if (!src || !src.includes('cdn.msisurfaces.com') || src.includes('svg')) return;

              // Extract color from the link text or URL
              const text = a.textContent.trim().toLowerCase();
              const href = a.href.toLowerCase();
              const pathParts = new URL(href).pathname.split('/').filter(Boolean);
              const colorSlug = pathParts[pathParts.length - 1] || '';

              if (colorSlug && colorSlug.length > 2) {
                imgs.set(colorSlug, src);
              }
              if (text.length > 2 && text.length < 50) {
                imgs.set(text, src);
              }
            });

            // All CDN images
            document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
              if (img.src.includes('svg') || img.src.includes('logo')) return;
              const alt = (img.alt || '').toLowerCase().trim();
              if (alt) imgs.set(alt, img.src);
            });

            return Object.fromEntries(imgs);
          });

          const imgEntries = Object.entries(pageImages);
          if (imgEntries.length > 0) {
            console.log(`  ${url}: ${imgEntries.length} images found`);
            foundOnPage = true;

            for (const p of products) {
              if (!needsImage.has(p.id)) continue;

              const color = getColor(p.display_name, series).toLowerCase();
              const colorSlug = slugify(color);

              // Try to find matching image by color
              let bestImg = null;
              for (const [key, imgUrl] of imgEntries) {
                if (key.includes(color) || key.includes(colorSlug) ||
                    color.includes(key) || colorSlug.includes(key.replace(/-/g, ''))) {
                  bestImg = imgUrl;
                  break;
                }
              }

              // Fallback to og:image or first CDN image
              if (!bestImg && pageImages._og) bestImg = pageImages._og;
              if (!bestImg && imgEntries.length > 0) bestImg = imgEntries[0][1];

              if (bestImg) {
                const saved = await saveImage(p.id, bestImg);
                if (saved) {
                  puppeteerMatched++;
                  needsImage.delete(p.id);
                  console.log(`    ✓ ${p.display_name} → ${bestImg}`);
                }
              }
            }
          }
        } catch {}
      }
    }

    await browser.close();
    totalMatched += puppeteerMatched;
    console.log(`Phase 2: ${puppeteerMatched} matched\n`);
  }

  // ===== Phase 3: Last resort - share from broader series matches =====
  // Allow sharing from same-series siblings even if their images aren't perfectly verified
  const stillMissing = missing.filter(m => needsImage.has(m.id));
  if (stillMissing.length > 0) {
    console.log(`=== Phase 3: Broader series sharing (${stillMissing.length} remaining) ===`);
    let phase3 = 0;

    for (const m of stillMissing) {
      if (!needsImage.has(m.id)) continue;

      const series = getSeries(m.display_name);
      const seriesLower = series.toLowerCase();
      if (seriesLower.length < 4) continue;
      if (['gold', 'new', 'blue'].includes(seriesLower)) continue;

      // Find ANY sibling with any image (less strict than Phase 1)
      const { rows: siblings } = await pool.query(`
        SELECT p.display_name, ma.url
        FROM products p
        JOIN vendors v2 ON p.vendor_id = v2.id
        JOIN media_assets ma ON ma.product_id = p.id AND ma.sort_order = 0
        WHERE v2.code = 'MSI' AND p.status = 'active' AND p.is_active = true
          AND lower(p.display_name) LIKE lower($1) || ' %'
          AND p.id != $2
          AND ma.url NOT LIKE '%/svg/%'
          AND ma.url NOT LIKE '%stacked-stone-veneers%'
        ORDER BY
          CASE WHEN ma.url LIKE '/uploads/%' THEN 0 ELSE 1 END,
          p.display_name
        LIMIT 1
      `, [series, m.id]);

      if (siblings.length > 0) {
        const saved = await saveImage(m.id, siblings[0].url);
        if (saved) {
          phase3++;
          totalMatched++;
          needsImage.delete(m.id);
          console.log(`  ✓ ${m.display_name} → from ${siblings[0].display_name}`);
        }
      }
    }
    console.log(`Phase 3: ${phase3} matched\n`);
  }

  // ===== Phase 4: Delete verified-wrong images =====
  // Products that have CDN images where URL doesn't contain any significant word from the product name
  // These are word-matcher artifacts
  console.log('=== Phase 4: Cleaning wrong images ===');

  const { rows: wrongOnes } = await pool.query(`
    WITH products_with_wrong AS (
      SELECT p.id, p.display_name,
        lower(split_part(p.display_name, ' ', 1)) as word1,
        lower(split_part(p.display_name, ' ', 2)) as word2,
        ma.id as media_id, ma.url
      FROM products p
      JOIN vendors v ON p.vendor_id = v.id
      JOIN media_assets ma ON ma.product_id = p.id
      WHERE v.code = 'MSI' AND p.status = 'active' AND p.is_active = true
        AND ma.url LIKE 'https://cdn.msisurfaces.com%'
        AND ma.url NOT LIKE '%/svg/%'
        AND length(split_part(p.display_name, ' ', 1)) >= 5
        -- First word of product name NOT in URL
        AND lower(ma.url) NOT LIKE '%' || lower(split_part(p.display_name, ' ', 1)) || '%'
        -- Also check second word (for added confidence)
        AND (length(split_part(p.display_name, ' ', 2)) < 4
             OR lower(ma.url) NOT LIKE '%' || lower(split_part(p.display_name, ' ', 2)) || '%')
    )
    SELECT COUNT(*) as cnt FROM products_with_wrong
  `);
  console.log(`Products with wrong CDN images (series name not in URL, color not in URL): ${wrongOnes[0].cnt}`);
  // Don't actually delete — just count. User can review and decide.

  // ===== Final Stats =====
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
  `, [vid]);
  console.log(`\nFinal Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
  console.log(`Total matched this run: ${totalMatched}`);

  // List remaining
  const finalMissing = missing.filter(m => needsImage.has(m.id));
  if (finalMissing.length > 0) {
    console.log(`\nStill missing (${finalMissing.length}):`);
    for (const m of finalMissing) {
      console.log(`  [${m.category}] ${m.display_name}`);
    }
  }

  await pool.end();
})();
