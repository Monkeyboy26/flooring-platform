/**
 * Vellichor Floors — Image Enrichment Scraper
 *
 * Products already imported from PDF price lists. This scraper visits
 * vellichorfloors.com (Wix site) to capture product images.
 *
 * The site has individual product pages at /vc-XXX URLs matching vendor SKUs.
 *
 * Usage: docker compose exec api node scrapers/vellichor.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, extractLargeImages, collectSiteWideImages,
  preferProductShot, upsertMediaAsset,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://www.vellichorfloors.com';

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'VELLICHOR'");
  if (!vendorRes.rows.length) { console.error('Vellichor vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all non-accessory SKUs
  const skuRows = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection, s.id as sku_id, s.internal_sku, s.vendor_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.variant_type IS NULL
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Found ${skuRows.rowCount} SKUs to enrich with images`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Collect site-wide images to exclude
    console.log('Collecting site-wide images to exclude...');
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    console.log(`Excluding ${siteWideImages.size} site-wide images\n`);

    // Also discover all product links from /products page
    console.log('Discovering product pages from /products...');
    let discoveredLinks = [];
    try {
      await page.goto(`${BASE_URL}/products`, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(3000);
      // Scroll fully to load lazy content
      await page.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          window.scrollBy(0, 400);
          await new Promise(r => setTimeout(r, 200));
        }
      });
      await delay(2000);

      discoveredLinks = await page.evaluate((base) => {
        const links = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          if (href && href.startsWith(base) && /\/vc-/i.test(href)) {
            if (!links.includes(href)) links.push(href);
          }
        }
        return links;
      }, BASE_URL);
      console.log(`Discovered ${discoveredLinks.length} product page links from /products`);
      for (const l of discoveredLinks) console.log(`  ${l}`);
    } catch (err) {
      console.log(`  Could not load /products: ${err.message}`);
    }

    // Build list of pages to visit: discovered links + fallback for each SKU
    let imagesSaved = 0;
    let skusMatched = 0;

    for (const row of skuRows.rows) {
      const sku = row.vendor_sku; // e.g., "VC-502"
      const skuLower = sku.toLowerCase(); // e.g., "vc-502"

      // Try the direct URL for this SKU
      const url = discoveredLinks.find(l => l.toLowerCase().includes(skuLower))
        || `${BASE_URL}/${skuLower}`;

      try {
        console.log(`\n[${sku}] ${row.name} — visiting ${url}`);
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

        if (!resp || resp.status() >= 400) {
          console.log(`  Page not found (${resp ? resp.status() : 'no response'})`);
          continue;
        }

        await delay(1500);

        // Scroll to load lazy images
        await page.evaluate(async () => {
          for (let i = 0; i < 8; i++) {
            window.scrollBy(0, 400);
            await new Promise(r => setTimeout(r, 250));
          }
          window.scrollTo(0, 0);
        });
        await delay(1000);

        const images = await extractLargeImages(page, siteWideImages, 100);
        console.log(`  Found ${images.length} images on page`);

        if (images.length === 0) continue;

        // All images on a product-specific page belong to this product
        const urls = images.map(i => i.src);
        const sorted = preferProductShot(urls, row.name);

        // Save up to 6 images per SKU
        const toSave = sorted.slice(0, 6);
        for (let i = 0; i < toSave.length; i++) {
          const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: assetType,
            url: toSave[i],
            original_url: toSave[i],
            sort_order: i,
          });
          imagesSaved++;
        }
        skusMatched++;
        console.log(`  Saved ${toSave.length} image(s)`);

      } catch (err) {
        console.log(`  Error: ${err.message}`);
      }

      // Polite delay between pages
      await delay(1000);
    }

    // Also try the gallery page for any remaining unmatched SKUs
    console.log('\n--- Checking /gallery for additional images ---');
    try {
      await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(2000);
      await page.evaluate(async () => {
        for (let i = 0; i < 15; i++) {
          window.scrollBy(0, 400);
          await new Promise(r => setTimeout(r, 200));
        }
      });
      await delay(2000);

      const galleryImages = await extractLargeImages(page, siteWideImages, 100);
      console.log(`Found ${galleryImages.length} gallery images`);

      // Try to match by alt text or URL containing color/product name
      for (const img of galleryImages) {
        const alt = (img.alt || '').toLowerCase();
        const src = img.src.toLowerCase();

        for (const row of skuRows.rows) {
          const name = row.name.toLowerCase();
          const skuCode = (row.vendor_sku || '').toLowerCase();

          // Check if this SKU already has a primary image
          const existing = await pool.query(
            `SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' LIMIT 1`,
            [row.sku_id]
          );
          if (existing.rowCount > 0) continue;

          if (alt.includes(name) || src.includes(name.replace(/\s+/g, '-')) ||
              src.includes(name.replace(/\s+/g, '')) ||
              (skuCode && (alt.includes(skuCode) || src.includes(skuCode)))) {
            await upsertMediaAsset(pool, {
              product_id: row.product_id,
              sku_id: row.sku_id,
              asset_type: 'primary',
              url: img.src,
              original_url: img.src,
              sort_order: 0,
            });
            imagesSaved++;
            skusMatched++;
            console.log(`  Gallery match: ${row.name} (${row.vendor_sku})`);
          }
        }
      }
    } catch (err) {
      console.log(`  Gallery error: ${err.message}`);
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Images saved: ${imagesSaved}`);
    console.log(`SKUs with images: ${skusMatched} / ${skuRows.rowCount}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
