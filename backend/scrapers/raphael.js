/**
 * Raphael Stone Collection — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper fetches product
 * images from XML sitemaps (which embed image:loc tags) across both Raphael sites:
 *   - raphaelp.com — Porcelain Tile + Pavers
 *   - raphaelstoneusa.com — Quartz, Quartzite, Marble, Natural Stone
 *
 * Strategy:
 *   1. Fetch all sitemaps and parse <url> entries with <image:loc> tags
 *   2. Match sitemap images to DB products by SKU code extracted from image filenames
 *   3. Fallback: match by URL slug → DB product name
 *   4. Save images to media_assets at product level
 *
 * No Puppeteer needed — all data comes from sitemap XML.
 *
 * Usage: docker compose exec api node scrapers/raphael.js
 */
import pg from 'pg';
import { filterImageUrls, saveProductImages } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Both Raphael websites and their sitemaps
const SITEMAPS = [
  'https://raphaelp.com/product-sitemap1.xml',
  'https://raphaelp.com/product-sitemap2.xml',
  'https://www.raphaelstoneusa.com/product-sitemap.xml',
];

const UA = 'Mozilla/5.0 (compatible; RomaBot/1.0)';

/**
 * Parse sitemap XML and extract entries: { pageUrl, slug, images[] }
 */
async function fetchSitemapEntries(sitemapUrl) {
  try {
    const resp = await fetch(sitemapUrl, { headers: { 'User-Agent': UA } });
    if (!resp.ok) { console.log(`  ${sitemapUrl} → HTTP ${resp.status}`); return []; }
    const xml = await resp.text();

    const entries = [];
    // Split on <url> blocks
    const urlBlocks = xml.split('<url>').slice(1); // skip preamble
    for (const block of urlBlocks) {
      const locMatch = block.match(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/);
      if (!locMatch) continue;
      const pageUrl = locMatch[1].trim();

      // Must be a product page (under /design/)
      if (!pageUrl.includes('/design/')) continue;

      // Extract slug from URL
      const slug = pageUrl.replace(/\/+$/, '').split('/').pop();

      // Extract all image:loc entries
      const images = [];
      const imgRegex = /<image:loc>\s*(https?:\/\/[^<]+)\s*<\/image:loc>/g;
      let m;
      while ((m = imgRegex.exec(block)) !== null) {
        images.push(m[1].trim());
      }

      if (images.length > 0) {
        entries.push({ pageUrl, slug, images });
      }
    }
    return entries;
  } catch (err) {
    console.log(`  Error fetching ${sitemapUrl}: ${err.message}`);
    return [];
  }
}

/**
 * Extract vendor SKU from an image filename.
 * Patterns:
 *   raphaelp.com:       RP1012_1.webp → RP1012
 *   raphaelstoneusa.com: PC-RQ09937_TP-... → RQ09937
 *                        PC-RQZ6118_TP-... → RQZ6118
 *                        PC-RMS0042_TP-... → RMS0042
 */
function extractSkuFromImageUrl(url) {
  const filename = url.split('/').pop();
  // Pattern 1: starts with RP/RQ/RQZ/RMS followed by digits, then underscore
  const m1 = filename.match(/^(R(?:P|Q|QZ|MS)\d+(?:-[A-Z]+)?)/i);
  if (m1) return m1[1].toUpperCase();
  // Pattern 2: PC- prefix (raphaelstoneusa.com renders)
  const m2 = filename.match(/^PC-(R(?:P|Q|QZ|MS)\d+(?:-[A-Z]+)?)/i);
  if (m2) return m2[1].toUpperCase();
  return null;
}

function normalizeForMatch(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'RAPHAEL'");
  if (!vendorRes.rows.length) { console.error('Raphael vendor not found'); await pool.end(); return; }
  const vendorId = vendorRes.rows[0].id;

  // Load all Raphael products with their SKUs
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           array_agg(DISTINCT s.vendor_sku) as vendor_skus
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.is_active = true
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.name
  `, [vendorId]);

  // Check which products already have images
  const existingImages = await pool.query(`
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  const products = dbProducts.rows;
  const needsImages = products.filter(r => !alreadyHasImage.has(r.product_id));
  console.log(`Total products: ${products.length}`);
  console.log(`Already have images: ${alreadyHasImage.size}`);
  console.log(`Need images: ${needsImages.length}\n`);

  if (!needsImages.length) { console.log('All products have images.'); await pool.end(); return; }

  // Build lookup maps
  // 1. vendor_sku → product (strip suffixes like -L, -LG, -P for base SKU matching)
  const productsByBaseSku = new Map();
  const productsByFullSku = new Map();
  const productsByName = new Map();

  for (const row of needsImages) {
    const norm = normalizeForMatch(row.name);
    productsByName.set(norm, row);

    for (const sku of (row.vendor_skus || [])) {
      if (!sku) continue;
      productsByFullSku.set(sku.toUpperCase(), row);
      // Base SKU: strip suffix after hyphen (RMS0042-L → RMS0042)
      const base = sku.toUpperCase().replace(/-[A-Z]+$/i, '');
      if (!productsByBaseSku.has(base)) {
        productsByBaseSku.set(base, row);
      }
    }

    // Also store slug-like version of name
    const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    productsByName.set(slug.replace(/-/g, ''), row);
  }

  // Fetch all sitemaps
  console.log('=== Fetching sitemaps ===');
  const allEntries = [];
  for (const sm of SITEMAPS) {
    const entries = await fetchSitemapEntries(sm);
    console.log(`  ${sm} → ${entries.length} products with images`);
    allEntries.push(...entries);
  }
  console.log(`Total sitemap entries with images: ${allEntries.length}\n`);

  // Match sitemap entries to DB products
  console.log('=== Matching and saving images ===');
  let matched = 0;
  let saved = 0;
  const matchedProductIds = new Set();

  for (const entry of allEntries) {
    // Strategy 1: Match by SKU code in image filenames
    let dbProd = null;
    for (const imgUrl of entry.images) {
      const sku = extractSkuFromImageUrl(imgUrl);
      if (sku) {
        dbProd = productsByFullSku.get(sku) || productsByBaseSku.get(sku);
        if (dbProd) break;
      }
    }

    // Strategy 2: Match by URL slug → product name
    if (!dbProd) {
      const slugNorm = normalizeForMatch(entry.slug);
      dbProd = productsByName.get(slugNorm);
    }

    // Strategy 3: Fuzzy slug match (slug contains name or vice versa)
    if (!dbProd) {
      const slugNorm = normalizeForMatch(entry.slug);
      for (const [norm, prod] of productsByName) {
        if (norm.length >= 6 && (slugNorm.includes(norm) || norm.includes(slugNorm))) {
          dbProd = prod;
          break;
        }
      }
    }

    if (!dbProd || matchedProductIds.has(dbProd.product_id)) continue;
    matchedProductIds.add(dbProd.product_id);

    // Filter and save images
    const cleaned = filterImageUrls(entry.images, { maxImages: 6 });
    if (cleaned.length === 0) continue;

    const count = await saveProductImages(pool, dbProd.product_id, cleaned, { maxImages: 6 });
    console.log(`  ${dbProd.name} → ${count} image(s) [via ${entry.slug}]`);
    matched++;
    saved += count;
  }

  // Report unmatched
  const stillMissing = needsImages.filter(p => !matchedProductIds.has(p.product_id));
  console.log(`\n=== Complete ===`);
  console.log(`Products matched: ${matched}`);
  console.log(`Images saved: ${saved}`);
  console.log(`Still missing images: ${stillMissing.length}`);
  if (stillMissing.length > 0 && stillMissing.length <= 40) {
    console.log('Missing:');
    for (const p of stillMissing) {
      console.log(`  ${p.name} (${(p.vendor_skus || []).join(', ')})`);
    }
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
