#!/usr/bin/env node
/**
 * MSI Local Image → CDN Replacement
 *
 * Replaces local /uploads/ images with CDN equivalents for MSI products.
 * This handles the case where different products have different local URLs
 * but they all contain the same (or wrong) image because they were copied
 * during import rather than fetched per-product from the CDN.
 *
 * Usage:
 *   node backend/scripts/msi-replace-local-images.cjs --dry-run
 *   node backend/scripts/msi-replace-local-images.cjs
 *   node backend/scripts/msi-replace-local-images.cjs --category "LVP (Plank)"
 */
const { Pool } = require('pg');
const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');
const catIdx = process.argv.indexOf('--category');
const CATEGORY_FILTER = catIdx !== -1 ? process.argv[catIdx + 1] : null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const CDN = 'https://cdn.msisurfaces.com/images';

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function headUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 6000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function cleanName(name) {
  return name
    .replace(/[-\s]*\d+\/\d+-\d+mm\s*$/i, '')
    .replace(/[-\s]*[\d.]+x[\d.]+-\d+\/\d+-\d+mm$/i, '')
    .replace(/[-\s]*[\d.]+x[\d.]+\s*$/i, '')
    .replace(/\s*-\s*$/, '')
    .trim();
}

function generateLvpUrls(name, collection) {
  const cleaned = cleanName(name);
  const nameSlug = slugify(cleaned);
  const collSlug = collection ? slugify(collection) : '';
  const urls = [];

  // Handle "Res." prefix
  const isReserve = /^Res\.\s+/i.test(cleaned);
  const baseNameNoRes = isReserve ? cleaned.replace(/^Res\.\s+/i, '').trim() : null;
  const baseSlugNoRes = baseNameNoRes ? slugify(baseNameNoRes) : null;

  if (baseSlugNoRes) {
    urls.push(`${CDN}/lvt/detail/${baseSlugNoRes}-resrve-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/${baseSlugNoRes}-reserve-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/reserve-${baseSlugNoRes}-vinyl-flooring.jpg`);
    if (collSlug) urls.push(`${CDN}/lvt/detail/${collSlug}-${baseSlugNoRes}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/colornames/${baseSlugNoRes}-resrve.jpg`);
    urls.push(`${CDN}/colornames/${baseSlugNoRes}.jpg`);
  }

  if (collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${nameSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/${nameSlug}-${collSlug}-vinyl-flooring.jpg`);
  }
  urls.push(`${CDN}/lvt/detail/${nameSlug}-vinyl-flooring.jpg`);
  if (collSlug) urls.push(`${CDN}/colornames/${nameSlug}-${collSlug}.jpg`);
  urls.push(`${CDN}/colornames/${nameSlug}.jpg`);

  return [...new Set(urls)];
}

function generateOtherUrls(name, collection, category) {
  const nameSlug = slugify(cleanName(name));
  const collSlug = collection ? slugify(collection) : '';
  const urls = [];

  if (['Porcelain Tile', 'Large Format Tile'].includes(category)) {
    if (collSlug) {
      urls.push(`${CDN}/porcelainceramic/iso/${collSlug}-${nameSlug}-iso.jpg`);
      urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-${collSlug}-iso.jpg`);
      urls.push(`${CDN}/porcelainceramic/${collSlug}-${nameSlug}-porcelain.jpg`);
      urls.push(`${CDN}/porcelainceramic/${nameSlug}-${collSlug}-porcelain.jpg`);
    }
    urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }
  if (['Mosaic Tile', 'Backsplash Tile', 'Backsplash & Wall Tile'].includes(category)) {
    urls.push(`${CDN}/mosaics/variations/${nameSlug}.jpg`);
    urls.push(`${CDN}/mosaics/${nameSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }
  if (['Hardscaping', 'Stacked Stone', 'Pavers'].includes(category)) {
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}.jpg`);
    urls.push(`${CDN}/hardscaping/${nameSlug}.jpg`);
    if (collSlug) {
      urls.push(`${CDN}/hardscaping/detail/${nameSlug}-${collSlug}.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${collSlug}-${nameSlug}.jpg`);
    }
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }
  if (['Natural Stone', 'Marble Countertops', 'Granite Countertops', 'Quartzite Countertops'].includes(category)) {
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    urls.push(`${CDN}/natural-stone/detail/${nameSlug}.jpg`);
    urls.push(`${CDN}/natural-stone/${nameSlug}.jpg`);
  }
  if (category === 'Transitions & Moldings') {
    const trimMatch = name.match(/^(.+?)\s+(Ec|Ecl|Osn|Fsn|Fsnl|Qr|Srl?|St|Tl?|T-Sr|4-In-1|Rt)(?:-Ee|-Sr|-W)?\s+[\d.]+"?\s*$/i);
    const baseName = trimMatch ? trimMatch[1].trim() : name;
    const baseSlug = slugify(baseName);
    for (const coll of ['prescott', 'cyrus', 'xl-cyrus', 'xl-prescott', 'andover']) {
      urls.push(`${CDN}/lvt/detail/${coll}-${baseSlug}-vinyl-flooring.jpg`);
    }
    urls.push(`${CDN}/lvt/detail/${baseSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/colornames/${baseSlug}.jpg`);
  }
  if (['Engineered Hardwood', 'Waterproof Wood'].includes(category)) {
    if (collSlug) {
      urls.push(`${CDN}/lvt/detail/${collSlug}-${nameSlug}-vinyl-flooring.jpg`);
    }
    urls.push(`${CDN}/lvt/detail/${nameSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    if (collSlug) urls.push(`${CDN}/colornames/${nameSlug}-${collSlug}.jpg`);
  }

  return [...new Set(urls)];
}

async function main() {
  console.log(`\nMSI Local Image → CDN Replacement${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (CATEGORY_FILTER) console.log(`Category filter: "${CATEGORY_FILTER}"`);
  console.log('='.repeat(60) + '\n');

  const client = await pool.connect();
  try {
    if (!DRY_RUN) await client.query('BEGIN');

    // Get all MSI products with local /uploads/ primary images
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.display_name, p.collection, c.name as category,
             m.url as current_url, m.id as media_id
      FROM media_assets m
      JOIN products p ON p.id = m.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE v.code = 'MSI' AND m.asset_type = 'primary' AND m.sku_id IS NULL
        AND p.status = 'active' AND m.url LIKE '/uploads/%'
        ${CATEGORY_FILTER ? "AND c.name = $1" : ""}
      ORDER BY c.name, p.collection, p.name
    `, CATEGORY_FILTER ? [CATEGORY_FILTER] : []);

    console.log(`MSI products with local images: ${products.length}\n`);

    // Category breakdown
    const catCounts = {};
    for (const p of products) catCounts[p.category] = (catCounts[p.category] || 0) + 1;
    console.log('By category:');
    for (const [cat, cnt] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${cnt}`);
    }
    console.log();

    // Group by category
    const byCategory = new Map();
    for (const p of products) {
      if (!byCategory.has(p.category)) byCategory.set(p.category, []);
      byCategory.get(p.category).push(p);
    }

    let fixed = 0, skipped = 0;

    for (const [category, prods] of byCategory) {
      console.log(`\n--- ${category} (${prods.length} products) ---`);

      // Generate candidates for all products
      const productCandidates = prods.map(p => ({
        product: p,
        candidates: category === 'LVP (Plank)'
          ? generateLvpUrls(p.name, p.collection)
          : generateOtherUrls(p.name, p.collection, p.category),
      }));

      // Collect all unique URLs
      const allUrls = new Set();
      for (const { candidates } of productCandidates) {
        for (const url of candidates) allUrls.add(url);
      }

      const urlList = [...allUrls];
      console.log(`  Checking ${urlList.length} candidate URLs...`);

      // Batch HEAD-check
      const validUrls = new Set();
      for (let i = 0; i < urlList.length; i += 25) {
        const batch = urlList.slice(i, i + 25);
        const results = await Promise.all(batch.map(url => headUrl(url)));
        for (const result of results) {
          if (result) validUrls.add(result);
        }
      }
      console.log(`  Found ${validUrls.size} valid CDN URLs`);

      for (const { product, candidates } of productCandidates) {
        let foundUrl = null;
        for (const url of candidates) {
          if (validUrls.has(url)) {
            foundUrl = url;
            break;
          }
        }

        if (foundUrl) {
          fixed++;
          const shortUrl = foundUrl.replace('https://cdn.msisurfaces.com/images/', '');
          console.log(`  ✓ ${product.name} [${product.collection}] → ${shortUrl}`);
          if (!DRY_RUN) {
            await client.query(
              'UPDATE media_assets SET url = $1, original_url = $2 WHERE id = $3',
              [foundUrl, foundUrl, product.media_id]
            );
          }
        } else {
          skipped++;
        }
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  Total with local images: ${products.length}`);
    console.log(`  Replaced with CDN:       ${fixed}`);
    console.log(`  No CDN available:        ${skipped}`);

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log('\nAll changes committed.');
    } else {
      console.log('\nDry run - no changes made.');
    }
  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK');
    console.error('\nError:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
