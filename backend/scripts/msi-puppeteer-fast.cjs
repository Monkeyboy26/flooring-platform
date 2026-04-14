#!/usr/bin/env node
/**
 * MSI Fast Puppeteer — Visit MSI product pages with 10s timeout.
 * Constructs URLs from product names and category, visits with Puppeteer,
 * extracts images. Uses fast 10s timeout to skip 404s quickly.
 */
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function nameToSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractBase(name) {
  return name
    .replace(/\s+\d+\s*Mm\b.*/i, '')
    .replace(/\s+\d{4}\s+/g, ' ')
    .replace(/\s+(Matte|Polished|Honed|Glossy|Lappato|Satin|Rectified)\s*$/i, '')
    .replace(/\s+(3d|Mosaic|Bullnose|Hexagon)\s*.*/i, '')
    .replace(/\s*\(\s*\d+\s*Pcs?\s.*/i, '')
    .replace(/\s*(Cop|Pav|Tread|Stepping|Cobble|Pebble|Coping|Pool|Kits|Pattern|Shotblast|Sandblast|Tumbl|Honed|Unfil|Eased|Mini|Grande|River|Beach|Boulder|Xl|Hand\s*Cut|Thick).*/i, '')
    .replace(/x\d+.*/i, '')
    .replace(/\s+\d+["']?.*/i, '')
    .trim();
}

const CATEGORY_PATHS = {
  'Porcelain Tile': '/porcelain-tile/',
  'Stacked Stone': '/hardscape/rockmount-stacked-stone/',
  'Natural Stone': '/marble-tile/',
  'Mosaic Tile': '/mosaics/',
  'Hardscaping': '/hardscape/',
  'Pavers': '/hardscape/',
  'Backsplash & Wall Tile': '/backsplash-tile/',
};

async function extractImages(page) {
  return page.evaluate(() => {
    const imgs = new Set();
    const og = document.querySelector('meta[property="og:image"]');
    if (og) {
      const s = og.getAttribute('content');
      if (s && s.includes('cdn.msisurfaces.com')) imgs.add(s);
    }
    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(sc.textContent);
        const list = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
        for (const u of list) if (u && u.includes('cdn.msisurfaces.com')) imgs.add(u);
        if (d['@graph']) for (const i of d['@graph']) {
          if (i.image) {
            const ii = Array.isArray(i.image) ? i.image : [i.image];
            for (const u of ii) if (u && u.includes('cdn.msisurfaces.com')) imgs.add(u);
          }
        }
      } catch {}
    }
    document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
      const s = img.src;
      if (s && !(/icon|logo|badge|placeholder|thumbnails|flyers|brochures|miscellaneous|roomvo/i.test(s))) imgs.add(s);
    });
    return [...imgs].slice(0, 6);
  });
}

async function tryUrl(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!resp || resp.status() >= 400) return null;

    // Wait just a bit for JS to execute
    await delay(2000);

    // Quick check — does the page have product content?
    const hasContent = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      return h1 && h1.textContent.trim().length > 2;
    });
    if (!hasContent) return null;

    // Expand accordions
    await page.evaluate(() => {
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show'); el.style.display = ''; el.style.height = 'auto';
      });
    });
    await delay(500);

    const images = await extractImages(page);
    if (images.length === 0) return null;

    // Get SKU codes
    const skus = await page.evaluate(() => {
      const codes = [];
      const lines = (document.body.innerText || '').split('\n');
      for (const l of lines) {
        const m = l.trim().match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
        if (m) codes.push(m[1]);
      }
      return codes;
    });

    return { images, skus };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name, c.name as category,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.vendor_sku IS NOT NULL) as vendor_skus
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    GROUP BY p.id, p.display_name, c.name
    ORDER BY c.name, p.display_name
  `, [vid]);

  console.log(`Missing: ${missing.length}`);

  // Build SKU lookup
  const { rows: allSkus } = await pool.query(`
    SELECT s.product_id, s.vendor_sku, s.internal_sku
    FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vid]);
  const skuByVendor = new Map(allSkus.map(s => [s.vendor_sku?.toUpperCase(), s]));
  const skuByInternal = new Map(allSkus.map(s => [s.internal_sku?.toUpperCase(), s]));

  const needsImage = new Set(missing.map(m => m.id));

  // Group by base name
  const baseGroups = new Map();
  for (const m of missing) {
    const b = extractBase(m.display_name);
    if (!baseGroups.has(b)) baseGroups.set(b, []);
    baseGroups.get(b).push(m);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let matched = 0;
  let visited = 0;
  const baseUrl = 'https://www.msisurfaces.com';

  for (const [baseName, products] of baseGroups) {
    if (products.every(p => !needsImage.has(p.id))) continue;
    if (!baseName || baseName.length < 3) continue;

    // Skip products with M S International Inc. prefix (generic names)
    if (baseName.startsWith('M S International')) continue;

    const category = products[0].category;
    const catPath = CATEGORY_PATHS[category] || '/porcelain-tile/';
    const slug = nameToSlug(baseName);
    const words = slug.split('-').filter(w => w.length > 0);

    if (!slug || slug.length < 3) continue;

    // Generate candidate URLs (most specific first)
    const candidates = [];
    if (words.length >= 2) {
      // /category/series/color/
      candidates.push(`${baseUrl}${catPath}${words.slice(0, -1).join('-')}/${words[words.length - 1]}/`);
      candidates.push(`${baseUrl}${catPath}${words[0]}/${words.slice(1).join('-')}/`);
    }
    candidates.push(`${baseUrl}${catPath}${slug}/`);

    // For stacked stone: try rockmount prefix
    if (category === 'Stacked Stone' && !slug.startsWith('rockmount')) {
      candidates.push(`${baseUrl}/hardscape/rockmount-stacked-stone/${slug.replace(/^rockmount-/, '')}/`);
    }

    // Try alternate category paths for porcelain
    if (category === 'Porcelain Tile') {
      candidates.push(`${baseUrl}/large-format-tile/${slug}/`);
      candidates.push(`${baseUrl}/wood-look-tile-and-planks/${slug}/`);
      if (words.length >= 2) {
        candidates.push(`${baseUrl}/porcelain-tile/${words[0]}/${words.slice(1).join('-')}/`);
      }
    }

    let found = false;
    for (const url of candidates) {
      if (found) break;
      visited++;

      const data = await tryUrl(browser, url);
      if (!data) continue;

      // Apply images to all products in this group
      for (const p of products) {
        if (!needsImage.has(p.id)) continue;

        let saved = 0;
        for (let i = 0; i < data.images.length && i < 5; i++) {
          const assetType = i === 0 ? 'primary' : 'alternate';
          try {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, $2, $3, $3, $4)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [p.id, assetType, data.images[i], i]);
            saved++;
          } catch {}
        }
        if (saved > 0) {
          matched++;
          needsImage.delete(p.id);
          found = true;
        }
      }

      await delay(800);
    }

    if (!found) await delay(300); // small delay even for misses

    if (visited % 25 === 0 && visited > 0) {
      console.log(`  ${visited} URLs, ${matched} matched, ${needsImage.size} remaining`);
    }
  }

  await browser.close();

  console.log(`\nPuppeteer: ${matched} matched from ${visited} URLs`);

  // Final coverage
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
  console.log(`Still missing: ${stats.total - stats.with_images}`);

  await pool.end();
})();
