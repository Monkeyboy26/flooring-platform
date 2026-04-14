#!/usr/bin/env node
/**
 * MSI Collection Page Scraper — Visit MSI collection pages, extract product links,
 * visit each one to grab images and SKU codes, and match to our DB.
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
    .replace(/\s+(Cop|Pav|Tread|Cobble|Pebble|Coping|Pool|Kits|Pattern).*/i, '')
    .replace(/x\d+.*/i, '')
    .replace(/\s+\d+["']?.*/i, '')
    .trim();
}

// Extract first word (likely the collection/series name)
function extractCollection(name) {
  const base = extractBase(name);
  const words = base.split(/\s+/);
  if (words.length >= 2) {
    // Try 2-word collection names first (Chateau Luna, Kaya Onda, etc.)
    return [words.slice(0, 2).join(' '), words[0]];
  }
  return [words[0]];
}

async function extractPageData(page) {
  return page.evaluate(() => {
    const result = { images: [], skus: [], name: '', subLinks: [] };

    // Name
    const h1 = document.querySelector('h1');
    if (h1) result.name = h1.textContent.trim();

    // Images
    const imgSet = new Set();
    const og = document.querySelector('meta[property="og:image"]');
    if (og) {
      const s = og.getAttribute('content');
      if (s && s.includes('cdn.msisurfaces.com')) imgSet.add(s);
    }
    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(sc.textContent);
        const list = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
        for (const u of list) if (u && u.includes('cdn.msisurfaces.com')) imgSet.add(u);
        if (d['@graph']) for (const i of d['@graph']) {
          if (i.image) {
            const ii = Array.isArray(i.image) ? i.image : [i.image];
            for (const u of ii) if (u && u.includes('cdn.msisurfaces.com')) imgSet.add(u);
          }
        }
      } catch {}
    }
    document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
      const s = img.src;
      if (s && !(/icon|logo|badge|placeholder|thumbnails|flyers|brochures|miscellaneous|roomvo/i.test(s))) imgSet.add(s);
    });
    result.images = [...imgSet].slice(0, 8);

    // SKU codes
    const lines = (document.body.innerText || '').split('\n');
    const seen = new Set();
    for (const l of lines) {
      const m = l.trim().match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
      if (m && !seen.has(m[1])) { seen.add(m[1]); result.skus.push(m[1]); }
    }

    // Sub-links (for collection pages that list color variants)
    const baseHost = window.location.origin;
    const currentPath = window.location.pathname.replace(/\/$/, '');
    const linkSeen = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!href || href.includes('javascript:')) return;
      try {
        const url = new URL(href);
        if (url.origin !== baseHost) return;
        const path = url.pathname.replace(/\/$/, '');
        if (!path.startsWith(currentPath + '/')) return;
        const sub = path.slice(currentPath.length + 1);
        if (!sub || sub.includes('/')) return;
        if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos|warranty)$/i.test(path)) return;
        const full = url.origin + path + '/';
        if (linkSeen.has(full)) return;
        linkSeen.add(full);
        result.subLinks.push(full);
      } catch {}
    });

    return result;
  });
}

async function visitAndExtract(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    if (!resp || resp.status() >= 400) return null;

    await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {});

    // Expand accordions
    await page.evaluate(() => {
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show'); el.style.display = ''; el.style.height = 'auto';
      });
      document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('active', 'in', 'show'); el.style.display = '';
      });
    });
    await delay(800);

    return await extractPageData(page);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function saveImages(productId, images) {
  let saved = 0;
  for (let i = 0; i < images.length && i < 5; i++) {
    const assetType = i === 0 ? 'primary' : 'alternate';
    try {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, $2, $3, $3, $4)
        ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
      `, [productId, assetType, images[i], i]);
      saved++;
    } catch {}
  }
  return saved;
}

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  // Get missing products
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

  // Build name lookup for fuzzy matching
  const nameToProduct = new Map();
  for (const m of missing) {
    const norm = m.display_name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    nameToProduct.set(norm, m);
    // Also add base name
    const base = extractBase(m.display_name).toLowerCase();
    if (!nameToProduct.has(base)) nameToProduct.set(base, m);
  }

  // Identify unique collection names to visit
  const collectionsToVisit = new Set();
  for (const m of missing) {
    if (m.display_name.startsWith('M S International')) continue;
    const colls = extractCollection(m.display_name);
    for (const c of colls) {
      if (c && c.length >= 3) collectionsToVisit.add(c);
    }
  }

  console.log(`Collections to visit: ${collectionsToVisit.size}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let totalMatched = 0;
  let visited = 0;
  const baseUrl = 'https://www.msisurfaces.com';
  const visitedUrls = new Set();

  const catPaths = {
    'Porcelain Tile': ['/porcelain-tile/'],
    'Natural Stone': ['/marble-tile/', '/travertine-tile/', '/granite-tile/', '/limestone-tile/', '/slate-tile/'],
    'Mosaic Tile': ['/mosaics/', '/backsplash-tile/'],
    'Stacked Stone': ['/hardscape/rockmount-stacked-stone/'],
    'Hardscaping': ['/hardscape/'],
  };

  // Determine which category paths to use for each collection
  const collectionCategory = {};
  for (const m of missing) {
    const colls = extractCollection(m.display_name);
    for (const c of colls) {
      if (!collectionCategory[c]) collectionCategory[c] = m.category;
    }
  }

  for (const collection of collectionsToVisit) {
    if (needsImage.size === 0) break;

    const slug = nameToSlug(collection);
    const cat = collectionCategory[collection] || 'Porcelain Tile';
    const paths = catPaths[cat] || ['/porcelain-tile/'];

    for (const catPath of paths) {
      const collUrl = `${baseUrl}${catPath}${slug}/`;
      if (visitedUrls.has(collUrl)) continue;
      visitedUrls.add(collUrl);
      visited++;

      console.log(`  Visiting: ${collUrl}`);
      const data = await visitAndExtract(browser, collUrl);
      if (!data) {
        await delay(500);
        continue;
      }

      // If this page has SKU codes, match directly
      let matched = false;
      if (data.skus.length > 0 && data.images.length > 0) {
        for (const code of data.skus) {
          const clean = code.replace(/\s+/g, '-').toUpperCase();
          const match = skuByInternal.get('MSI-' + clean) || skuByVendor.get(clean);
          if (match && needsImage.has(match.product_id)) {
            const saved = await saveImages(match.product_id, data.images);
            if (saved > 0) {
              totalMatched++;
              needsImage.delete(match.product_id);
              matched = true;
              console.log(`    ✓ SKU match: ${code} → product ${match.product_id}`);
            }
          }
        }
      }

      // Try name matching on the page name
      if (!matched && data.images.length > 0 && data.name) {
        const pageName = data.name.toLowerCase()
          .replace(/\s*(porcelain|ceramic|marble|granite|travertine|tile|plank|flooring|wood|luxury|vinyl|collection|series).*/gi, '')
          .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

        // Find missing products whose name starts with this page name
        for (const m of missing) {
          if (!needsImage.has(m.id)) continue;
          const mNorm = m.display_name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          if (pageName && (mNorm.startsWith(pageName) || pageName.startsWith(mNorm.split(' ').slice(0, 2).join(' ')))) {
            const saved = await saveImages(m.id, data.images);
            if (saved > 0) {
              totalMatched++;
              needsImage.delete(m.id);
              console.log(`    ✓ Name match: "${m.display_name}" from "${data.name}"`);
            }
          }
        }
      }

      // Drill into sub-links
      if (data.subLinks.length > 0) {
        console.log(`    ${data.subLinks.length} sub-links found`);
        for (const subUrl of data.subLinks) {
          if (needsImage.size === 0) break;
          if (visitedUrls.has(subUrl)) continue;
          visitedUrls.add(subUrl);
          visited++;

          const subData = await visitAndExtract(browser, subUrl);
          if (!subData || subData.images.length === 0) {
            await delay(500);
            continue;
          }

          // Match by SKU
          for (const code of subData.skus) {
            const clean = code.replace(/\s+/g, '-').toUpperCase();
            const match = skuByInternal.get('MSI-' + clean) || skuByVendor.get(clean);
            if (match && needsImage.has(match.product_id)) {
              const saved = await saveImages(match.product_id, subData.images);
              if (saved > 0) {
                totalMatched++;
                needsImage.delete(match.product_id);
                console.log(`    ✓ Sub SKU match: ${code}`);
              }
            }
          }

          // Name match from sub-page
          if (subData.name) {
            const subName = subData.name.toLowerCase()
              .replace(/\s*(porcelain|ceramic|marble|granite|travertine|tile|plank|flooring|wood|luxury|vinyl|collection|series).*/gi, '')
              .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

            for (const m of missing) {
              if (!needsImage.has(m.id)) continue;
              const mBase = extractBase(m.display_name).toLowerCase();
              if (subName && (mBase === subName || mBase.startsWith(subName) || subName.startsWith(mBase))) {
                const saved = await saveImages(m.id, subData.images);
                if (saved > 0) {
                  totalMatched++;
                  needsImage.delete(m.id);
                  console.log(`    ✓ Sub name match: "${m.display_name}" from "${subData.name}"`);
                }
              }
            }
          }

          await delay(1200);
        }
      }

      await delay(1000);
    }
  }

  await browser.close();

  // Final: share images between variants of the same base name
  console.log('\n--- Post-scrape name sharing ---');
  let shared = 0;
  const baseGroups = new Map();
  for (const m of missing) {
    const b = extractBase(m.display_name);
    if (!baseGroups.has(b)) baseGroups.set(b, []);
    baseGroups.get(b).push(m);
  }
  for (const [_, products] of baseGroups) {
    const donor = products.find(p => !needsImage.has(p.id));
    if (!donor) continue;
    const { rows: imgs } = await pool.query(
      'SELECT url, original_url, asset_type, sort_order FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3',
      [donor.id]
    );
    for (const p of products) {
      if (!needsImage.has(p.id)) continue;
      for (const img of imgs) {
        try {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, NULL, $2, $3, $4, $5)
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [p.id, img.asset_type, img.url, img.original_url, img.sort_order]);
        } catch {}
      }
      if (imgs.length > 0) { shared++; needsImage.delete(p.id); }
    }
  }
  console.log(`  Shared: ${shared}`);

  // Final stats
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);

  console.log(`\nTotal: ${totalMatched + shared} matched (${totalMatched} scraped + ${shared} shared)`);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
  console.log(`Still missing: ${stats.total - stats.with_images}`);

  await pool.end();
})();
