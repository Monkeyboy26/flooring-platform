/**
 * Ottimo Ceramics — Image Enrichment Scraper
 *
 * Fetches product images from Ottimo's Shopify storefront (ottimoceramics.com)
 * via the public /products.json API. No Puppeteer needed.
 *
 * Coverage: Shopify site has ~35 products (~80 variants) vs ~640 SKUs in the
 * PDF price list. Most products will remain image-less until Ottimo adds more
 * to their site. Admin can manually upload images later.
 *
 * Runs AFTER import-ottimo.js populates SKUs in the DB.
 *
 * Usage: docker compose exec api node scrapers/ottimo.js
 */
import pg from 'pg';
import { saveProductImages, preferProductShot, filterImageUrls } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://ottimoceramics.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Fetch all Shopify products via JSON API ───
async function fetchAllShopifyProducts() {
  const products = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/products.json?limit=250&page=${page}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      if (page === 1) throw new Error(`Shopify JSON API returned ${resp.status}`);
      break;
    }

    const data = await resp.json();
    const batch = data.products || [];

    if (batch.length === 0) break;
    products.push(...batch);

    if (batch.length < 250) break;
    page++;
    await delay(500);
  }

  return products;
}

// ─── Normalize SKU for matching ───
function normalizeSku(sku) {
  if (!sku) return '';
  return sku.toUpperCase().replace(/[-_\s]/g, '').replace(/\*+$/, '');
}

// ─── Main ───
async function run() {
  console.log('Ottimo Ceramics — Image Enrichment\n');

  // Load all Ottimo SKUs from DB
  const dbResult = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name AS product_name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = (SELECT id FROM vendors WHERE code = 'OTTIMO')
      AND s.status = 'active'
  `);

  if (dbResult.rows.length === 0) {
    console.log('No Ottimo SKUs found in DB. Run import-ottimo.js first.');
    await pool.end();
    return;
  }

  console.log(`Found ${dbResult.rows.length} Ottimo SKUs in DB`);

  // Build vendor_sku → { sku_id, product_id } lookup
  const skuMap = new Map();
  const productSkus = new Map(); // product_id → [vendor_skus]
  for (const row of dbResult.rows) {
    const norm = normalizeSku(row.vendor_sku);
    skuMap.set(norm, { skuId: row.sku_id, productId: row.product_id, vendorSku: row.vendor_sku });

    if (!productSkus.has(row.product_id)) productSkus.set(row.product_id, []);
    productSkus.get(row.product_id).push(row.vendor_sku);
  }

  // Fetch Shopify products
  console.log('Fetching Shopify product catalog...');
  const shopifyProducts = await fetchAllShopifyProducts();
  console.log(`Fetched ${shopifyProducts.length} Shopify products\n`);

  let matchedProducts = 0;
  let savedImages = 0;
  const matchedProductIds = new Set();

  for (const sp of shopifyProducts) {
    // Try to match Shopify variants to DB SKUs
    let matchedProductId = null;

    for (const variant of (sp.variants || [])) {
      const shopifySku = normalizeSku(variant.sku);
      if (!shopifySku) continue;

      const match = skuMap.get(shopifySku);
      if (match) {
        matchedProductId = match.productId;
        break;
      }
    }

    // Also try matching by Shopify product title against collection names
    if (!matchedProductId && sp.title) {
      const titleNorm = sp.title.toUpperCase().replace(/[-_\s]+/g, ' ').trim();
      for (const row of dbResult.rows) {
        const collNorm = (row.collection || '').toUpperCase().replace(/[-_\s]+/g, ' ').trim();
        const nameNorm = (row.product_name || '').toUpperCase().replace(/[-_\s]+/g, ' ').trim();
        if (collNorm && titleNorm.includes(collNorm) && titleNorm.includes(nameNorm)) {
          matchedProductId = row.product_id;
          break;
        }
      }
    }

    if (!matchedProductId || matchedProductIds.has(matchedProductId)) continue;
    matchedProductIds.add(matchedProductId);

    // Extract images from Shopify product
    const imageUrls = (sp.images || []).map(img => img.src).filter(Boolean);
    if (imageUrls.length === 0) continue;

    const filtered = filterImageUrls(imageUrls);
    const sorted = preferProductShot(filtered, sp.title);

    if (sorted.length === 0) continue;

    const count = await saveProductImages(pool, matchedProductId, sorted);
    savedImages += count;
    matchedProducts++;

    console.log(`  ${sp.title}: ${count} images saved`);
  }

  console.log(`\n=== Image Enrichment Complete ===`);
  console.log(`Shopify products: ${shopifyProducts.length}`);
  console.log(`Matched to DB: ${matchedProducts}`);
  console.log(`Images saved: ${savedImages}`);
  console.log(`Unmatched products in DB: ${productSkus.size - matchedProducts}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
