#!/usr/bin/env node
/**
 * MSI Last 10 — Final Puppeteer attempt for the 10 remaining products.
 * Visits specific MSI product pages with full networkidle2 rendering.
 */
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Manually constructed URLs to try for each product
const PRODUCT_URLS = {
  'Alura Polished': [
    'https://www.msisurfaces.com/porcelain-tile/alura/',
    'https://www.msisurfaces.com/large-format-tile/alura/',
  ],
  'Ayres Blendx8mm': [
    'https://www.msisurfaces.com/mosaics/collections-mosaics/ayres/',
    'https://www.msisurfaces.com/mosaic-tile/ayres/',
    'https://www.msisurfaces.com/backsplash-tile/glass-tile/ayres/',
  ],
  'Carolina Timber Saddle Matte': [
    'https://www.msisurfaces.com/wood-look-tile-and-planks/carolina-timber/',
    'https://www.msisurfaces.com/porcelain-tile/carolina-timber/',
    'https://www.msisurfaces.com/wood-look-tile-and-planks/carolina-timber/saddle/',
  ],
  'Cristaline Polished': [
    'https://www.msisurfaces.com/porcelain-tile/cristaline/',
    'https://www.msisurfaces.com/large-format-tile/cristaline/',
  ],
  'Dune Silk Matte': [
    'https://www.msisurfaces.com/porcelain-tile/dune-silk/',
    'https://www.msisurfaces.com/porcelain-tile/dune/',
    'https://www.msisurfaces.com/large-format-tile/dune-silk/',
  ],
  'Hawaiian Skyx4mm': [
    'https://www.msisurfaces.com/mosaics/collections-mosaics/hawaiian-sky/',
    'https://www.msisurfaces.com/mosaic-tile/hawaiian-sky/',
    'https://www.msisurfaces.com/backsplash-tile/glass-tile/hawaiian-sky/',
  ],
  'Seashell Bianco R11': [
    'https://www.msisurfaces.com/porcelain-tile/seashell/',
    'https://www.msisurfaces.com/commercial-tile/seashell/',
    'https://www.msisurfaces.com/porcelain-tile/seashell-bianco/',
  ],
  'Snowdrift White R11': [
    'https://www.msisurfaces.com/porcelain-tile/snowdrift/',
    'https://www.msisurfaces.com/commercial-tile/snowdrift/',
    'https://www.msisurfaces.com/porcelain-tile/snowdrift-white/',
  ],
  'Thundercloud Grey R11': [
    'https://www.msisurfaces.com/porcelain-tile/thundercloud/',
    'https://www.msisurfaces.com/commercial-tile/thundercloud/',
    'https://www.msisurfaces.com/porcelain-tile/thundercloud-grey/',
  ],
  'Travertino White R11': [
    'https://www.msisurfaces.com/porcelain-tile/travertino/',
    'https://www.msisurfaces.com/commercial-tile/travertino/',
    'https://www.msisurfaces.com/porcelain-tile/travertino-white/',
  ],
};

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
  `, [vid]);
  console.log(`Missing: ${missing.length}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  let matched = 0;

  for (const m of missing) {
    const urls = PRODUCT_URLS[m.display_name] || [];
    if (urls.length === 0) {
      console.log(`  No URLs configured for: ${m.display_name}`);
      continue;
    }

    let found = false;
    for (const url of urls) {
      if (found) break;

      try {
        console.log(`  Trying: ${url}`);
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
        if (!resp || resp.status() !== 200) {
          console.log(`    → ${resp ? resp.status() : 'no response'}`);
          continue;
        }

        // Wait for full JS rendering
        await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
        await delay(3000);

        // Extract images
        const images = await page.evaluate(() => {
          const imgs = [];
          // og:image
          const og = document.querySelector('meta[property="og:image"]');
          if (og && og.content && !og.content.includes('svg') && !og.content.includes('logo')) {
            imgs.push(og.content);
          }
          // JSON-LD
          document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
            try {
              const d = JSON.parse(s.textContent);
              if (d.image) {
                const ia = Array.isArray(d.image) ? d.image : [d.image];
                ia.forEach(u => { if (typeof u === 'string' && !u.includes('svg')) imgs.push(u); });
              }
            } catch {}
          });
          // CDN images
          document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
            if (!img.src.includes('svg') && !img.src.includes('logo') && !img.src.includes('icon')
                && !img.src.includes('cart') && !img.src.includes('thumbnail')
                && (img.src.endsWith('.jpg') || img.src.endsWith('.png') || img.src.endsWith('.webp'))) {
              imgs.push(img.src);
            }
          });
          return [...new Set(imgs)];
        });

        const title = await page.title().catch(() => '');
        console.log(`    Title: ${title.substring(0, 60)}`);
        console.log(`    Images found: ${images.length}`);

        if (images.length > 0) {
          try {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, 'primary', $2, $2, 0)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [m.id, images[0]]);
            matched++;
            found = true;
            console.log(`    ✓ Saved: ${images[0]}`);
          } catch (e) {
            console.log(`    Error saving: ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`    Error: ${e.message.substring(0, 80)}`);
      }
    }

    if (!found) {
      console.log(`  ✗ No images found for: ${m.display_name}`);
    }
    await delay(1500);
  }

  await browser.close();

  console.log(`\nMatched: ${matched}/${missing.length}`);

  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);

  await pool.end();
})();
