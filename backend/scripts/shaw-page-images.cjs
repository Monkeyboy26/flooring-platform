#!/usr/bin/env node
/**
 * shaw-page-images.cjs
 *
 * Scrape Shaw product detail pages to extract per-color image URLs.
 *
 * Shaw product pages embed a "colors" JSON array in the HTML with every
 * color's Widen CDN main image and img.shawinc.com room scene URL.
 *
 * Strategy:
 *   1. Download product page sitemaps to get all product URLs with style/color codes
 *   2. Deduplicate by style code (one page per style has ALL colors)
 *   3. Fetch each style page and extract the "colors" JSON
 *   4. Match color codes to our uncovered SKUs
 *   5. Insert primary + lifestyle images
 *
 * Usage:
 *   node backend/scripts/shaw-page-images.cjs --dry-run
 *   node backend/scripts/shaw-page-images.cjs
 */

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 300; // Polite delay between page fetches

const SITEMAP_INDEX = 'https://shawfloors.com/en-us/sitemap.xml';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/xml,*/*',
        'Accept-Encoding': 'identity',
      },
    }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function optimizeUrl(url) {
  if (!url) return null;
  if (url.includes('widen.net') && !url.includes('?')) {
    return url + '?w=800&quality=80';
  }
  return url;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  SHAW PAGE IMAGE SCRAPER ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Phase 1: Get all product page URLs from sitemaps
  console.log('Phase 1: Downloading product page sitemaps...');

  const indexXml = await fetchUrl(SITEMAP_INDEX);
  const indexRe = /<loc>([^<]+)<\/loc>/g;
  const sitemapUrls = [];
  let m;
  while ((m = indexRe.exec(indexXml)) !== null) {
    const url = m[1];
    // Product sitemaps are sampletype/7-11 (not images, pages, or videos)
    if (url.includes('/sampletype/') && !url.includes('/images/')) {
      sitemapUrls.push(url);
    }
  }
  console.log(`  Found ${sitemapUrls.length} product sitemaps`);

  // Parse product page URLs: extract style code from URL path
  // URL format: /en-us/{category}/{slug}/{styleCode}-{colorCode}
  const stylePages = new Map(); // styleCode -> first URL for that style
  const urlRe = /<loc>(https:\/\/shawfloors\.com\/en-us\/[^<]+\/([a-z0-9]+-[0-9]+))<\/loc>/g;

  for (const smUrl of sitemapUrls) {
    let xml;
    try {
      xml = await fetchUrl(smUrl);
    } catch (e) {
      // Handle sub-sitemap index
      if (e.message) console.log(`  Error: ${e.message}`);
      continue;
    }

    // Check if this is a sub-index
    if (xml.includes('<sitemapindex')) {
      const subUrls = [];
      const subRe = /<loc>([^<]+)<\/loc>/g;
      let sm;
      while ((sm = subRe.exec(xml)) !== null) subUrls.push(sm[1]);
      for (const su of subUrls) {
        try {
          const subXml = await fetchUrl(su);
          let pm;
          const re2 = /<loc>(https:\/\/shawfloors\.com\/en-us\/[^<]+\/([a-z0-9]+-[0-9]+))<\/loc>/g;
          while ((pm = re2.exec(subXml)) !== null) {
            const [, pageUrl, styleColor] = pm;
            const style = styleColor.split('-')[0];
            if (!stylePages.has(style)) {
              stylePages.set(style, pageUrl);
            }
          }
        } catch (e2) {
          console.log(`  Error fetching ${su}: ${e2.message}`);
        }
      }
    } else {
      let pm;
      while ((pm = urlRe.exec(xml)) !== null) {
        const [, pageUrl, styleColor] = pm;
        const style = styleColor.split('-')[0];
        if (!stylePages.has(style)) {
          stylePages.set(style, pageUrl);
        }
      }
    }
  }
  console.log(`  Unique styles with product pages: ${stylePages.size}\n`);

  // Phase 2: Find uncovered Shaw SKUs and build lookup
  console.log('Phase 2: Finding uncovered Shaw SKUs...');
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='SHAW'");
  const vendorId = vendorRes.rows[0].id;

  const { rows: uncoveredSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name AS product_name,
           EXISTS (
             SELECT 1 FROM media_assets ma
             WHERE ma.sku_id = s.id AND ma.asset_type = 'lifestyle'
           ) AS has_lifestyle,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'style_code' LIMIT 1) AS style_code,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'color_code' LIMIT 1) AS color_code
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.vendor_sku IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
      )
  `, [vendorId]);

  console.log(`  Found ${uncoveredSkus.length} uncovered Shaw SKUs`);

  // Build lookup: style_color -> sku data
  // Key format: lowercase "styleCode_colorCode" e.g. "zz224_00352"
  const skuByStyleColor = new Map();
  for (const sku of uncoveredSkus) {
    let style, color;
    if (sku.style_code && sku.color_code) {
      style = sku.style_code.trim().toLowerCase();
      color = sku.color_code.trim();
    } else {
      // Parse from vendor_sku
      const raw = sku.vendor_sku.trim().toLowerCase().replace(/\s+/g, '');
      if (raw.length >= 10) {
        style = raw.slice(0, 5);
        color = raw.slice(5);
      } else continue;
    }
    const key = `${style}_${color}`;
    if (!skuByStyleColor.has(key)) skuByStyleColor.set(key, []);
    skuByStyleColor.get(key).push(sku);
  }
  console.log(`  Unique style_color keys: ${skuByStyleColor.size}`);

  // Find which styles we need
  const neededStyles = new Set();
  for (const key of skuByStyleColor.keys()) {
    neededStyles.add(key.split('_')[0]);
  }

  // Filter to only styles that have pages AND we need
  const stylesToFetch = [];
  for (const [style, url] of stylePages) {
    if (neededStyles.has(style)) {
      stylesToFetch.push({ style, url });
    }
  }
  console.log(`  Styles to fetch (have page + need images): ${stylesToFetch.length}\n`);

  // Phase 3: Fetch product pages and extract color image data
  console.log('Phase 3: Scraping product pages for image URLs...');
  const toInsertPrimary = [];
  const toInsertLifestyle = [];
  let pagesScraped = 0;
  let pagesErrored = 0;
  let colorsMatched = 0;

  for (const { style, url } of stylesToFetch) {
    try {
      const html = await fetchUrl(url);
      pagesScraped++;

      // Extract "colors" JSON array
      const colorsMatch = html.match(/"colors":\[(\{[^]*?\})\]/);
      if (!colorsMatch) {
        if (pagesScraped % 50 === 0) console.log(`  [${pagesScraped}/${stylesToFetch.length}] ...`);
        continue;
      }

      // Parse the colors array
      let colors;
      try {
        colors = JSON.parse('[' + colorsMatch[1] + ']');
      } catch {
        // Try broader match
        const broader = html.match(/"colors":(\[[^\]]*\])/);
        if (broader) {
          try { colors = JSON.parse(broader[1]); } catch { continue; }
        } else continue;
      }

      for (const c of colors) {
        const colorCode = (c.sellingColorNumber || c.colorNumber || '').trim();
        if (!colorCode) continue;

        const key = `${style}_${colorCode}`;
        const skus = skuByStyleColor.get(key);
        if (!skus) continue;

        const mainUrl = c.image && c.image.url;
        const roomUrl = c.roomSceneImage && c.roomSceneImage.url;

        for (const sku of skus) {
          if (mainUrl) {
            toInsertPrimary.push({
              sku_id: sku.sku_id,
              product_id: sku.product_id,
              url: optimizeUrl(mainUrl),
              original_url: mainUrl,
            });
            colorsMatched++;
          }
          if (roomUrl && !sku.has_lifestyle) {
            toInsertLifestyle.push({
              sku_id: sku.sku_id,
              product_id: sku.product_id,
              url: roomUrl,
              original_url: roomUrl,
            });
          }
        }
      }

      if (pagesScraped % 20 === 0) {
        console.log(`  [${pagesScraped}/${stylesToFetch.length}] ${colorsMatched} colors matched so far`);
      }
    } catch (e) {
      pagesErrored++;
      if (pagesErrored <= 5) console.log(`  Error on ${style}: ${e.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`  Pages scraped: ${pagesScraped}`);
  console.log(`  Pages errored: ${pagesErrored}`);
  console.log(`  Primary images to insert: ${toInsertPrimary.length}`);
  console.log(`  Lifestyle images to insert: ${toInsertLifestyle.length}\n`);

  // Phase 4: Product-level primary promotions
  console.log('Phase 4: Building product-level primary promotions...');
  const { rows: existingProductPrimaries } = await pool.query(`
    SELECT DISTINCT product_id FROM media_assets
    WHERE asset_type = 'primary' AND sku_id IS NULL
      AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)
  `, [vendorId]);
  const hasProductPrimary = new Set(existingProductPrimaries.map(r => r.product_id));

  const productPrimary = new Map();
  for (const img of toInsertPrimary) {
    if (!hasProductPrimary.has(img.product_id) && !productPrimary.has(img.product_id)) {
      productPrimary.set(img.product_id, { url: img.url, original_url: img.original_url });
    }
  }
  console.log(`  Products already with primary: ${hasProductPrimary.size}`);
  console.log(`  Products getting promoted primary: ${productPrimary.size}\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  SKU primaries: ${toInsertPrimary.length}`);
  console.log(`  SKU lifestyles: ${toInsertLifestyle.length}`);
  console.log(`  Product primaries (promoted): ${productPrimary.size}`);
  console.log('='.repeat(60) + '\n');

  if (DRY_RUN) {
    console.log('Sample SKU primaries:');
    for (const p of toInsertPrimary.slice(0, 5)) {
      console.log(`  sku=${p.sku_id.substring(0, 8)} url=${p.url.substring(0, 90)}`);
    }
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  console.log('Applying changes...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const img of toInsertPrimary) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'primary', $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [img.product_id, img.sku_id, img.url, img.original_url]);
    }
    console.log(`  Inserted ${toInsertPrimary.length} SKU-level primaries`);

    for (const img of toInsertLifestyle) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'lifestyle', $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [img.product_id, img.sku_id, img.url, img.original_url]);
    }
    console.log(`  Inserted ${toInsertLifestyle.length} SKU-level lifestyles`);

    for (const [productId, imgData] of productPrimary) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $3, 0)
        ON CONFLICT DO NOTHING
      `, [productId, imgData.url, imgData.original_url]);
    }
    console.log(`  Inserted ${productPrimary.size} product-level primaries`);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
