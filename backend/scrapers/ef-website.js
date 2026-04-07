#!/usr/bin/env node

/**
 * Engineered Floors — Website Scraper (engineeredfloors.com)
 *
 * Puppeteer-based scraper for the EF JS SPA.
 * Extracts product descriptions, spec tables, and images for products
 * that are missing this data in the DB.
 *
 * URL pattern: https://www.engineeredfloors.com/products/{category}/{slug}
 * Seed URLs from the CSV Product URL column.
 *
 * Usage:
 *   node backend/scrapers/ef-website.js [--limit N] [--images-only]
 *   docker compose exec api node scrapers/ef-website.js [--limit N]
 */

import {
  launchBrowser,
  delay,
  upsertMediaAsset,
  upsertSkuAttribute,
  extractLargeImages,
  collectSiteWideImages,
  filterImageUrls,
  saveProductImages,
  saveSkuImages,
  preferProductShot,
  filterImagesByVariant,
  isLifestyleUrl,
} from './base.js';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://www.engineeredfloors.com';
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '2000', 10);
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const IMAGES_ONLY = process.argv.includes('--images-only');

// Known filler/brand-logo URLs to always exclude
const FILLER_URLS = new Set([
  'https://www.engineeredfloors.com/wp-content/uploads/2024/11/dreamweaver_white-png-webp.webp',
  'https://www.engineeredfloors.com/wp-content/themes/flynt/dist/assets/puregrain-87ab2e3d.png',
]);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ──────────────────────────────────────────────
// Build product URL list from CSV + DB
// ──────────────────────────────────────────────
function loadCsvUrls(csvPath) {
  if (!fs.existsSync(csvPath)) return new Map();
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n');
  const urlMap = new Map(); // productName → relative URL

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Parse just the fields we need: Product Name (col 2), Product URL (col 5)
    const fields = [];
    let field = '', quoted = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (quoted) {
        if (ch === '"' && line[j + 1] === '"') { field += '"'; j++; }
        else if (ch === '"') { quoted = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { quoted = true; }
        else if (ch === ',') { fields.push(field.trim()); field = ''; }
        else { field += ch; }
      }
    }
    fields.push(field.trim());

    const productName = fields[2]; // Product Name
    const productUrl = fields[5];   // Product URL

    if (productName && productUrl && !urlMap.has(productName)) {
      urlMap.set(productName, productUrl.replace(/^\/+/, ''));
    }
  }

  return urlMap;
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
  console.log('Engineered Floors — Website Scraper');
  console.log(`Delay: ${DELAY_MS}ms | Limit: ${LIMIT || 'all'} | Mode: ${IMAGES_ONLY ? 'images-only' : 'full'}\n`);

  // Load CSV URLs
  const csvPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'EF_Full_Product_Catalog.csv');
  const csvUrls = loadCsvUrls(csvPath);
  console.log(`CSV URLs loaded: ${csvUrls.size}`);

  // Get EF vendor
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'EF'");
  if (!vendorRes.rows.length) {
    console.error('EF vendor not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // Get products that need enrichment (prioritize those without images)
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_long,
           (SELECT COUNT(*) FROM media_assets ma WHERE ma.product_id = p.id) AS image_count,
           p.description_long IS NOT NULL AS has_description
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY
      (SELECT COUNT(*) FROM media_assets ma WHERE ma.product_id = p.id) ASC,
      p.name
  `, [vendorId]);

  let productsToScrape = productsRes.rows;
  if (LIMIT > 0) productsToScrape = productsToScrape.slice(0, LIMIT);

  console.log(`Products to scrape: ${productsToScrape.length} (of ${productsRes.rows.length} total)\n`);

  // Launch browser (uses Chrome from system or env var)
  const browser = await launchBrowser();

  let scraped = 0, imagesFound = 0, specsFound = 0, errors = 0;

  try {
    // Collect site-wide images to exclude
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    console.log('Collecting site-wide images...');
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    console.log(`Site-wide images to exclude: ${siteWideImages.size}\n`);

    for (const product of productsToScrape) {
      // Determine URL for this product
      let url = null;

      // Try CSV URL first
      const csvUrl = csvUrls.get(product.name);
      if (csvUrl) {
        url = `${BASE_URL}/${csvUrl}`;
      }

      // Fallback: guess URL from product name
      if (!url) {
        // Determine category from collection
        const collection = (product.collection || '').toLowerCase();
        let category = 'carpet';
        if (collection.includes('puregrain') || collection.includes('hard') ||
            collection.includes('lvt') || collection.includes('vinyl')) {
          category = 'hard-surface';
        }
        const slug = slugify(product.name);
        url = `${BASE_URL}/products/${category}/${slug}`;
      }

      console.log(`  Scraping: ${product.name} — ${url}`);

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(DELAY_MS);

        // Wait for SPA to render content
        await page.waitForSelector('body', { timeout: 5000 });
        await delay(1000);

        // Check if page has product content (not a 404/redirect)
        const hasContent = await page.evaluate(() => {
          const body = document.body.innerText;
          return body.length > 500 && !body.includes('Page Not Found') && !body.includes('404');
        });

        if (!hasContent) {
          console.log(`    ✗ No product content found`);
          errors++;
          continue;
        }

        // ── Extract images ──
        const largeImages = await extractLargeImages(page, siteWideImages, 100);
        const imageUrls = largeImages.map(img => img.src).filter(u => !FILLER_URLS.has(u));
        const filtered = filterImageUrls(imageUrls, { maxImages: 8 });

        if (filtered.length > 0 && parseInt(product.image_count) === 0) {
          const saved = await saveProductImages(pool, product.id, filtered);
          imagesFound += saved;
          console.log(`    + ${saved} images saved`);
        } else if (filtered.length > 0) {
          console.log(`    ~ ${filtered.length} images found (product already has ${parseInt(product.image_count)} images)`);
        }

        // ── Extract specs and description (unless --images-only) ──
        if (!IMAGES_ONLY) {
          const specs = await page.evaluate(() => {
            const result = {};

            // Look for spec tables or detail sections
            const specRows = document.querySelectorAll('table tr, .spec-row, .detail-row, [class*="spec"] tr');
            for (const row of specRows) {
              const cells = row.querySelectorAll('td, th, .label, .value');
              if (cells.length >= 2) {
                const label = cells[0].innerText.trim().toLowerCase();
                const value = cells[1].innerText.trim();
                if (label && value && value !== '-' && value !== 'N/A') {
                  result[label] = value;
                }
              }
            }

            // Look for description text
            const descEl = document.querySelector('.product-description, .description, [class*="description"], [class*="about"]');
            if (descEl) {
              result._description = descEl.innerText.trim();
            }

            // Also try meta description
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc) {
              result._meta_description = metaDesc.content;
            }

            return result;
          });

          // Map specs to attributes
          const specMap = {
            'wear layer': 'wear_layer',
            'thickness': 'thickness',
            'width': 'width',
            'length': 'length',
            'installation': 'installation_method',
            'installation method': 'installation_method',
            'construction': 'construction',
            'backing': 'material',
            'warranty': 'warranty',
            'finish': 'finish',
            'species': 'species',
            'fiber': 'fiber_brand',
          };

          // Get all SKUs for this product to set attributes
          const skuRes = await pool.query(
            'SELECT id FROM skus WHERE product_id = $1 AND status = $2',
            [product.id, 'active']
          );

          let specCount = 0;
          for (const [label, slug] of Object.entries(specMap)) {
            const value = specs[label];
            if (value) {
              for (const sku of skuRes.rows) {
                await upsertSkuAttribute(pool, sku.id, slug, value);
              }
              specCount++;
            }
          }

          // Update product description
          if (specs._description && !product.description_long) {
            await pool.query(
              'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
              [specs._description, product.id]
            );
          }

          if (specCount > 0) {
            specsFound += specCount;
            console.log(`    + ${specCount} specs extracted`);
          }
        }

        scraped++;
      } catch (err) {
        console.log(`    ✗ Error: ${err.message}`);
        errors++;
      }

      await delay(500);
    }

    await page.close();
  } finally {
    await browser.close();
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════');
  console.log('  EF Website Scraper Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`Products scraped:  ${scraped}`);
  console.log(`Images saved:      ${imagesFound}`);
  console.log(`Specs extracted:   ${specsFound}`);
  console.log(`Errors:            ${errors}`);
  console.log('═══════════════════════════════════════════\n');

  // Post-scrape verification
  const verify = await pool.query(`
    SELECT
      COUNT(DISTINCT p.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN p.id END) as with_images
    FROM products p
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vendorId]);
  const v = verify.rows[0];
  console.log(`Image coverage: ${v.with_images}/${v.total} products (${(v.with_images / v.total * 100).toFixed(1)}%)`);

  await pool.end();
}

main().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
