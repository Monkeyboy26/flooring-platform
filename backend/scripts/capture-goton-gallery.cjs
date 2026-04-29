/**
 * Capture rendered gallery images from gotontiles.com product pages.
 *
 * The Wix warmup data only contains a subset of product images (the color-selection
 * carousel). The rendered product page gallery (Wix Pro Gallery) shows additional
 * images including mosaic patterns, chevron, hexagon, opus, etc.
 *
 * This script uses Puppeteer to visit each product page, extract the full gallery
 * image list with original dimensions, and merges them into the product map JSON.
 *
 * Usage: docker compose exec api node scripts/capture-goton-gallery.cjs
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PRODUCT_MAP_PATH = path.join(__dirname, '..', 'data', 'goton-product-map.json');
const BASE_URL = 'https://www.gotontiles.com';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Extract gallery images from the rendered Wix product page.
 * Uses data-image-info attributes which contain original dimensions.
 */
async function extractGalleryImages(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Gallery images are inside elements with data-hook="ProductMediaDataHook.Images"
    // Each image wrapper has data-image-info JSON with original dimensions
    const imageInfoEls = document.querySelectorAll('[data-image-info]');

    for (const el of imageInfoEls) {
      try {
        const info = JSON.parse(el.getAttribute('data-image-info'));
        const imgData = info?.imageData;
        if (!imgData || !imgData.uri) continue;

        const match = imgData.uri.match(/(a0c5fc_[a-f0-9]+~mv2)/);
        if (!match) continue;
        if (seen.has(match[1])) continue;
        seen.add(match[1]);

        // Check parent for gallery hook to confirm it's a product gallery image
        let isGallery = false;
        let parent = el;
        for (let i = 0; i < 6 && parent; i++) {
          const hook = parent.getAttribute?.('data-hook') || '';
          if (hook.includes('ProductMedia') || hook.includes('product-gallery')) {
            isGallery = true;
            break;
          }
          parent = parent.parentElement;
        }

        results.push({
          id: match[1],
          url: imgData.uri,
          name: imgData.name || '',
          width: imgData.width || 0,
          height: imgData.height || 0,
          isGallery,
        });
      } catch (e) {
        // Skip malformed JSON
      }
    }

    // Fallback: also check img elements directly if data-image-info didn't capture all
    document.querySelectorAll('img').forEach(img => {
      const src = img.src || '';
      const match = src.match(/(a0c5fc_[a-f0-9]+~mv2)/);
      if (!match || seen.has(match[1])) return;

      // Skip tiny images (logos, icons)
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w > 0 && w < 50 && h < 50) return;

      // Check if this is in the product gallery area
      let inGallery = false;
      let parent = img.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        const hook = parent.getAttribute?.('data-hook') || '';
        if (hook.includes('ProductMedia') || hook.includes('product-gallery')) {
          inGallery = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!inGallery) return;

      seen.add(match[1]);

      // Try to extract original dimensions from the URL
      const dimMatch = src.match(/w_(\d+),h_(\d+)/);
      results.push({
        id: match[1],
        url: match[1] + '.jpg',
        name: '',
        width: dimMatch ? parseInt(dimMatch[1]) : w,
        height: dimMatch ? parseInt(dimMatch[2]) : h,
        isGallery: true,
      });
    });

    return results;
  });
}

async function run() {
  // Load existing product map
  const mapRaw = fs.readFileSync(PRODUCT_MAP_PATH, 'utf-8');
  const productMap = JSON.parse(mapRaw);

  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Block unnecessary resources to speed up loading
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const products = Object.entries(productMap.products);
  let processed = 0, updated = 0, errors = 0;

  for (const [name, data] of products) {
    const slug = data.slug;
    if (!slug) continue;

    processed++;
    process.stdout.write(`  [${processed}/${products.length}] ${name} (${slug})... `);

    try {
      await page.goto(`${BASE_URL}/product-page/${slug}`, {
        waitUntil: 'networkidle2', timeout: 45000,
      });
      await delay(2000); // Let gallery render

      const gallery = await extractGalleryImages(page);
      const galleryOnly = gallery.filter(img => img.isGallery);

      // Compare with existing warmup media
      const warmupIds = new Set((data.allMedia || []).map(m => {
        const match = (m.url || '').match(/(a0c5fc_[a-f0-9]+~mv2)/);
        return match ? match[1] : null;
      }).filter(Boolean));

      const newImages = galleryOnly.filter(img => !warmupIds.has(img.id));

      data.renderedGallery = galleryOnly.map(img => ({
        id: img.id,
        url: img.url,
        name: img.name,
        width: img.width,
        height: img.height,
        inWarmup: warmupIds.has(img.id),
      }));

      console.log(`${galleryOnly.length} gallery images (${newImages.length} new)`);
      updated++;
    } catch (err) {
      console.log(`ERROR: ${err.message.substring(0, 80)}`);
      data.renderedGallery = [];
      errors++;
    }

    await delay(800 + Math.random() * 400);
  }

  await browser.close();

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed} | Updated: ${updated} | Errors: ${errors}`);

  // Count total new images across all products
  let totalNew = 0, totalGallery = 0;
  for (const [, data] of Object.entries(productMap.products)) {
    if (!data.renderedGallery) continue;
    totalGallery += data.renderedGallery.length;
    totalNew += data.renderedGallery.filter(img => !img.inWarmup).length;
  }
  console.log(`Total gallery images: ${totalGallery} | New (not in warmup): ${totalNew}`);

  // Save updated product map
  productMap.renderedGalleryCapture = new Date().toISOString();
  fs.writeFileSync(PRODUCT_MAP_PATH, JSON.stringify(productMap, null, 2));
  console.log(`\nSaved to ${PRODUCT_MAP_PATH}`);
}

run().catch(err => { console.error(err); process.exit(1); });
