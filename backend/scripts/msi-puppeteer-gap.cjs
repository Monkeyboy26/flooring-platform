#!/usr/bin/env node
/**
 * MSI Puppeteer Gap Filler — Visit MSI product pages directly by constructing URLs
 * from product names. For the remaining ~294 products missing images.
 */

const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extract base product name (strip size/finish suffixes)
function extractBaseName(name) {
  return name
    .replace(/\s+\d+\s*Mm\b.*$/i, '')
    .replace(/\s+\d{4}\s+/g, ' ')    // "2448" → space
    .replace(/\s+(Matte|Polished|Honed|Glossy|Lappato|Satin|Rectified)\s*$/i, '')
    .replace(/\s+(3d|Mosaic|Bullnose|Hexagon)\s*.*$/i, '')
    .replace(/\s*\(\s*\d+\s*Pcs?\s.*$/i, '')
    .trim();
}

// Convert product name to URL slug
function nameToSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Category → MSI URL path prefixes
const CATEGORY_PATHS = {
  'Porcelain Tile': ['/porcelain-tile/', '/large-format-tile/', '/wood-look-tile-and-planks/'],
  'Stacked Stone': ['/hardscape/rockmount-stacked-stone/'],
  'Natural Stone': ['/marble-tile/', '/travertine-tile/', '/granite-tile/', '/quartzite-tile/', '/limestone-tile/', '/slate-tile/', '/onyx-tile/'],
  'Mosaic Tile': ['/mosaics/', '/backsplash-tile/glass-tile/', '/backsplash-tile/'],
  'Hardscaping': ['/hardscape/arterra-porcelain-pavers/', '/hardscape/'],
  'Pavers': ['/hardscape/arterra-porcelain-pavers/'],
  'Backsplash & Wall Tile': ['/backsplash-tile/', '/backsplash-tile/acoustic-wood-slat/'],
};

async function extractImagesFromPage(page) {
  return page.evaluate(() => {
    const imgs = new Set();

    // og:image
    const og = document.querySelector('meta[property="og:image"]');
    if (og) {
      const src = og.getAttribute('content');
      if (src && src.includes('cdn.msisurfaces.com')) imgs.add(src);
    }

    // JSON-LD
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(script.textContent);
        const list = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
        for (const u of list) {
          if (u && u.includes('cdn.msisurfaces.com')) imgs.add(u);
        }
        if (d['@graph']) {
          for (const item of d['@graph']) {
            if (item.image) {
              const ii = Array.isArray(item.image) ? item.image : [item.image];
              for (const u of ii) if (u && u.includes('cdn.msisurfaces.com')) imgs.add(u);
            }
          }
        }
      } catch {}
    }

    // CDN img tags
    document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
      const src = img.src;
      if (src && !(/icon|logo|badge|placeholder|thumbnails|flyers|brochures|miscellaneous|roomvo/i.test(src))) {
        imgs.add(src);
      }
    });

    return [...imgs].slice(0, 6);
  });
}

async function visitPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) return null;

    await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {});

    // Expand accordions
    await page.evaluate(() => {
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show'); el.style.display = ''; el.style.height = 'auto';
      });
    });
    await delay(500);

    const images = await extractImagesFromPage(page);
    const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() || '');

    // Also get SKU codes
    const skus = await page.evaluate(() => {
      const codes = [];
      const lines = (document.body.innerText || '').split('\n');
      for (const l of lines) {
        const m = l.trim().match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
        if (m) codes.push(m[1]);
      }
      return codes;
    });

    return { images, h1, skus, url };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function saveImages(db, productId, imageUrls) {
  let saved = 0;
  for (let i = 0; i < imageUrls.length && i < 5; i++) {
    const assetType = i === 0 ? 'primary' : 'alternate';
    try {
      await db.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, $2, $3, $3, $4)
        ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
      `, [productId, assetType, imageUrls[i], i]);
      saved++;
    } catch {}
  }
  return saved;
}

async function main() {
  console.log('MSI Puppeteer Gap Filler');
  console.log('='.repeat(60));

  const { rows: [vendor] } = await pool.query(`SELECT id FROM vendors WHERE code = 'MSI'`);
  const vid = vendor.id;

  // Get all missing products
  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name, p.collection, c.name as category,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.vendor_sku IS NOT NULL) as vendor_skus
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    GROUP BY p.id, p.display_name, p.collection, c.name
    ORDER BY c.name, p.display_name
  `, [vid]);

  console.log(`Products missing images: ${missing.length}`);

  // Build SKU lookup for matching
  const { rows: allSkus } = await pool.query(`
    SELECT s.product_id, s.vendor_sku, s.internal_sku
    FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vid]);
  const skuByVendor = new Map(allSkus.map(s => [s.vendor_sku?.toUpperCase(), s]));
  const skuByInternal = new Map(allSkus.map(s => [s.internal_sku?.toUpperCase(), s]));

  const needsImage = new Set(missing.map(m => m.id));

  // --- Strategy 1: Direct URL construction and Puppeteer visit ---
  console.log('\n--- Strategy 1: Direct URL visit ---');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let directMatched = 0;
  let visited = 0;
  const baseUrl = 'https://www.msisurfaces.com';

  // Group products by base name to avoid redundant visits
  const baseGroups = new Map(); // baseName → [products]
  for (const m of missing) {
    const base = extractBaseName(m.display_name);
    if (!baseGroups.has(base)) baseGroups.set(base, []);
    baseGroups.get(base).push(m);
  }

  console.log(`  Unique base names: ${baseGroups.size} (from ${missing.length} products)`);

  for (const [baseName, products] of baseGroups) {
    // Skip if all products in this group already have images
    if (products.every(p => !needsImage.has(p.id))) continue;

    const category = products[0].category;
    const paths = CATEGORY_PATHS[category] || ['/porcelain-tile/'];
    const slug = nameToSlug(baseName);

    if (!slug || slug.length < 3) continue;

    // Build candidate URLs
    const words = slug.split('-').filter(w => w.length > 0);
    const candidateUrls = new Set();

    // Try collection/color structure: /category/first-word/rest-of-words/
    if (words.length >= 2) {
      for (const path of paths) {
        candidateUrls.add(`${baseUrl}${path}${words[0]}/${words.slice(1).join('-')}/`);
        candidateUrls.add(`${baseUrl}${path}${words.slice(0, -1).join('-')}/${words[words.length - 1]}/`);
        candidateUrls.add(`${baseUrl}${path}${slug}/`);
      }
    } else {
      for (const path of paths) {
        candidateUrls.add(`${baseUrl}${path}${slug}/`);
      }
    }

    let found = false;
    for (const url of candidateUrls) {
      if (found) break;
      visited++;

      const data = await visitPage(browser, url);
      if (!data || data.images.length === 0) {
        await delay(1000);
        continue;
      }

      // Match: check if scraped page SKUs match any of our products
      let matchedProducts = [];

      // First try SKU matching
      for (const code of data.skus) {
        const clean = code.replace(/\s+/g, '-').toUpperCase();
        const match = skuByInternal.get('MSI-' + clean) || skuByVendor.get(clean);
        if (match && needsImage.has(match.product_id)) {
          matchedProducts.push(match.product_id);
        }
      }

      // If no SKU match, apply images to all products in this name group
      if (matchedProducts.length === 0) {
        matchedProducts = products.filter(p => needsImage.has(p.id)).map(p => p.id);
      }

      for (const pid of matchedProducts) {
        const imgCount = await saveImages(pool, pid, data.images);
        if (imgCount > 0) {
          directMatched++;
          needsImage.delete(pid);
          found = true;
        }
      }

      await delay(1500);
    }

    if (visited % 50 === 0 && visited > 0) {
      console.log(`  Progress: ${visited} URLs visited, ${directMatched} products matched, ${needsImage.size} remaining`);
    }
  }

  console.log(`  Direct URL visit: ${directMatched} matched from ${visited} URLs`);

  // --- Strategy 2: Category page crawl for remaining ---
  if (needsImage.size > 0) {
    console.log(`\n--- Strategy 2: Category page crawl (${needsImage.size} remaining) ---`);
    let crawlMatched = 0;

    // Determine which category pages to crawl
    const categoriesNeeded = new Set();
    for (const m of missing) {
      if (needsImage.has(m.id)) categoriesNeeded.add(m.category);
    }

    const categoryUrls = [];
    for (const cat of categoriesNeeded) {
      const paths = CATEGORY_PATHS[cat] || [];
      for (const p of paths) {
        categoryUrls.push(baseUrl + p);
      }
    }

    for (const catUrl of categoryUrls) {
      console.log(`  Crawling: ${catUrl}`);
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });

      try {
        await page.goto(catUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        // Click "Load More" repeatedly
        for (let attempt = 0; attempt < 30; attempt++) {
          const loadMore = await page.evaluateHandle(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links.find(a =>
              a.textContent.trim().toLowerCase().includes('load more') &&
              window.getComputedStyle(a).display !== 'none'
            ) || null;
          });
          const isEl = await loadMore.evaluate(el => el !== null).catch(() => false);
          if (!isEl) break;
          await loadMore.click().catch(() => {});
          await delay(2500);
        }

        // Collect all product links
        const productLinks = await page.evaluate((baseHost) => {
          const results = [];
          const seen = new Set();
          document.querySelectorAll('.new-filter-collection a[href], a[href]').forEach(a => {
            let href = a.href;
            if (!href || href.includes('javascript:')) return;
            try {
              const url = new URL(href);
              if (url.origin !== baseHost) return;
              const path = url.pathname;
              const segs = path.split('/').filter(Boolean);
              if (segs.length < 2) return;
              if (/\.(pdf|jpg|png|svg)$/i.test(path)) return;
              if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos|warranty)\/?$/i.test(path)) return;
              if (seen.has(path)) return;
              seen.add(path);
              results.push(url.origin + path + (path.endsWith('/') ? '' : '/'));
            } catch {}
          });
          return results;
        }, baseUrl);

        console.log(`    Found ${productLinks.length} product links`);

        for (const link of productLinks) {
          if (needsImage.size === 0) break;

          const data = await visitPage(browser, link);
          if (!data || data.images.length === 0) {
            await delay(1000);
            continue;
          }

          // Match by SKU code
          for (const code of data.skus) {
            const clean = code.replace(/\s+/g, '-').toUpperCase();
            const match = skuByInternal.get('MSI-' + clean) || skuByVendor.get(clean);
            if (match && needsImage.has(match.product_id)) {
              const imgCount = await saveImages(pool, match.product_id, data.images);
              if (imgCount > 0) {
                crawlMatched++;
                needsImage.delete(match.product_id);
              }
            }
          }

          await delay(1500);
        }
      } catch (err) {
        console.log(`    Error: ${err.message}`);
      } finally {
        await page.close();
      }
    }

    console.log(`  Category crawl: ${crawlMatched} additional matches`);
    directMatched += crawlMatched;
  }

  // --- Strategy 3: Same-base-name image sharing ---
  if (needsImage.size > 0) {
    console.log(`\n--- Strategy 3: Base name image sharing (${needsImage.size} remaining) ---`);
    let shared = 0;

    for (const [baseName, products] of baseGroups) {
      // Find the first product in this group that HAS images
      const donor = products.find(p => !needsImage.has(p.id));
      if (!donor) continue;

      // Copy images to remaining products in this group
      const { rows: imgs } = await pool.query(`
        SELECT url, original_url, asset_type, sort_order
        FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3
      `, [donor.id]);

      for (const recipient of products) {
        if (!needsImage.has(recipient.id)) continue;
        for (const img of imgs) {
          try {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, $2, $3, $4, $5)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [recipient.id, img.asset_type, img.url, img.original_url, img.sort_order]);
          } catch {}
        }
        if (imgs.length > 0) {
          shared++;
          needsImage.delete(recipient.id);
        }
      }
    }

    console.log(`  Base name sharing: ${shared} products got images`);
    directMatched += shared;
  }

  // --- Strategy 4: Broader name matching for hardscaping ---
  if (needsImage.size > 0) {
    console.log(`\n--- Strategy 4: Broader name matching (${needsImage.size} remaining) ---`);
    let broad = 0;

    // Load ALL imaged MSI products with their display names
    const { rows: imagedProds } = await pool.query(`
      SELECT p.id, p.display_name
      FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
        AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    `, [vid]);

    for (const m of missing) {
      if (!needsImage.has(m.id)) continue;

      // Extract the core material/product name (aggressive stripping)
      let core = m.display_name
        .replace(/\s*(Cop|Pav|Tread|Stepping|Cobble|Pebble|Coping|Pool|Kits|Pattern|Shotblast|Sandblast|Tumbl|Honed|Unfil|Eased|Mini|Grande|River|Beach|Boulder|Xl|Hand\s+Cut|Thick|Corners?|Sq\s*&?\s*Rec|Sawn|Ashlar|Veneer|Fieldstone|Premium).*$/i, '')
        .replace(/x\d+.*$/i, '')
        .replace(/\s+\d+["'"]?.*$/i, '')
        .replace(/\s+(Ec|Fsn|Osn|Qr|Sr|T|Tl)\s*$/i, '')
        .trim();

      if (!core || core.length < 4) continue;
      const coreLower = core.toLowerCase();

      // Find any imaged product whose name starts with this core
      const donor = imagedProds.find(ip =>
        ip.display_name.toLowerCase().startsWith(coreLower)
      );

      if (donor) {
        const { rows: imgs } = await pool.query(`
          SELECT url, original_url, asset_type, sort_order
          FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3
        `, [donor.id]);

        for (const img of imgs) {
          try {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, $2, $3, $4, $5)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [m.id, img.asset_type, img.url, img.original_url, img.sort_order]);
          } catch {}
        }
        if (imgs.length > 0) {
          broad++;
          needsImage.delete(m.id);
        }
      }
    }

    console.log(`  Broader matching: ${broad} products got images`);
    directMatched += broad;
  }

  await browser.close();

  // Final report
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);

  console.log('\n' + '='.repeat(60));
  console.log(`Total matched this run: ${directMatched}`);
  console.log(`Final coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
  console.log(`Still missing: ${stats.total - stats.with_images}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
