#!/usr/bin/env node
/**
 * MSI Search-Based Image Finder — Uses MSI's site search to find product images.
 * Visits search results pages with Puppeteer to get correct product images.
 */
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractSeriesName(displayName) {
  return displayName
    .replace(/\s+\d{4}\s*/g, ' ')
    .replace(/\s+(Matte|Polished|Glossy|Honed|Lappato|Satin)\s*.*$/i, '')
    .replace(/\s+(Bullnose|Mosaic|3d)\s*.*$/i, '')
    .replace(/\s+(R11|R10|R9)\s*$/i, '')
    .replace(/x\d+mm\s*$/i, '')
    .replace(/x\.\d+.*$/i, '')
    .replace(/Realex.*$/i, '')
    .replace(/Crown Molding/i, '')
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
    ORDER BY c.name, p.display_name
  `, [vid]);
  console.log(`Missing: ${missing.length} products\n`);

  // Group by series to avoid searching the same thing multiple times
  const seriesGroups = new Map();
  for (const m of missing) {
    const series = extractSeriesName(m.display_name);
    if (!seriesGroups.has(series)) seriesGroups.set(series, []);
    seriesGroups.get(series).push(m);
  }
  console.log(`Unique search terms: ${seriesGroups.size}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  let matched = 0;
  const needsImage = new Set(missing.map(m => m.id));

  for (const [series, products] of seriesGroups) {
    if (products.every(p => !needsImage.has(p.id))) continue;
    if (!series || series.length < 3) continue;

    const searchQuery = encodeURIComponent(series);
    const searchUrl = `https://www.msisurfaces.com/site-search?q=${searchQuery}`;

    try {
      console.log(`Searching: "${series}"...`);
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(3000); // Wait for JS-rendered search results

      // Extract all product result images and links
      const results = await page.evaluate(() => {
        const items = [];

        // Try various search result selectors
        const selectors = [
          '.search-result', '.product-card', '.product-tile',
          '.search-item', '[class*="result"]', '.tile',
          '.card', 'article'
        ];

        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const img = el.querySelector('img');
            const link = el.querySelector('a');
            const title = el.querySelector('h2, h3, h4, .title, .name, [class*="title"], [class*="name"]');

            if (img && (img.src || img.getAttribute('data-src'))) {
              const imgUrl = img.src || img.getAttribute('data-src');
              if (imgUrl && imgUrl.includes('msisurfaces.com') && !imgUrl.includes('svg') && !imgUrl.includes('logo')) {
                items.push({
                  image: imgUrl,
                  link: link ? link.href : '',
                  title: title ? title.textContent.trim() : (img.alt || ''),
                });
              }
            }
          }
        }

        // Also try looking for any CDN images on the page
        if (items.length === 0) {
          const allImgs = document.querySelectorAll('img[src*="cdn.msisurfaces.com"]');
          for (const img of allImgs) {
            if (!img.src.includes('svg') && !img.src.includes('logo') && !img.src.includes('icon')) {
              items.push({
                image: img.src,
                link: '',
                title: img.alt || '',
              });
            }
          }
        }

        return items;
      });

      if (results.length > 0) {
        console.log(`  Found ${results.length} results`);

        // Find best matching result for each product in this group
        for (const p of products) {
          if (!needsImage.has(p.id)) continue;

          // Try to find a result matching the product name
          const pName = p.display_name.toLowerCase();
          const words = pName.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 3);

          let bestResult = null;
          let bestScore = 0;

          for (const r of results) {
            const titleLower = (r.title + ' ' + r.link + ' ' + r.image).toLowerCase();
            let score = 0;
            for (const w of words) {
              if (titleLower.includes(w)) score++;
            }
            if (score > bestScore) {
              bestScore = score;
              bestResult = r;
            }
          }

          // Require at least the series name to match
          const seriesWord = series.split(' ')[0].toLowerCase();
          if (bestResult && bestScore >= 1 && (bestResult.title + bestResult.link + bestResult.image).toLowerCase().includes(seriesWord)) {
            try {
              await pool.query(`
                INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
                VALUES ($1, NULL, 'primary', $2, $2, 0)
                ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
                DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
              `, [p.id, bestResult.image]);
              matched++;
              needsImage.delete(p.id);
              console.log(`  ✓ ${p.display_name} → ${bestResult.image}`);
            } catch {}
          }
        }
      } else {
        console.log(`  No results found`);

        // Try visiting the product page directly as fallback
        // Construct URL from series name
        const slug = series.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const directUrls = [
          `https://www.msisurfaces.com/porcelain-tile/${slug}/`,
          `https://www.msisurfaces.com/natural-stone-tile/${slug}/`,
          `https://www.msisurfaces.com/mosaic-tile/${slug}/`,
          `https://www.msisurfaces.com/ceramic-tile/${slug}/`,
        ];

        for (const url of directUrls) {
          try {
            const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            if (!resp || resp.status() !== 200) continue;
            await delay(2000);

            const images = await page.evaluate(() => {
              const imgs = [];
              const ogImg = document.querySelector('meta[property="og:image"]');
              if (ogImg && ogImg.content && !ogImg.content.includes('default') && !ogImg.content.includes('logo')) {
                imgs.push(ogImg.content);
              }
              // JSON-LD
              for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                  const d = JSON.parse(s.textContent);
                  if (d.image) {
                    const ia = Array.isArray(d.image) ? d.image : [d.image];
                    ia.forEach(u => { if (typeof u === 'string') imgs.push(u); });
                  }
                } catch {}
              }
              // CDN images
              document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
                if (!img.src.includes('svg') && !img.src.includes('logo') && !img.src.includes('icon')) {
                  imgs.push(img.src);
                }
              });
              return [...new Set(imgs)].filter(u => u.endsWith('.jpg') || u.endsWith('.png') || u.endsWith('.webp'));
            });

            if (images.length > 0) {
              for (const p of products) {
                if (!needsImage.has(p.id)) continue;
                try {
                  await pool.query(`
                    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
                    VALUES ($1, NULL, 'primary', $2, $2, 0)
                    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
                    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
                  `, [p.id, images[0]]);
                  matched++;
                  needsImage.delete(p.id);
                  console.log(`  ✓ ${p.display_name} → ${images[0]} (direct)`);
                } catch {}
              }
              break;
            }
          } catch {}
        }
      }

      await delay(2000); // Rate limiting
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }

  await browser.close();

  console.log(`\nSearch phase: ${matched} matched\n`);

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
