#!/usr/bin/env node
/**
 * MSI Shared Image Fix
 *
 * Fixes MSI products that share the same primary image with other products.
 * For each affected product, tries to find a unique CDN image URL.
 *
 * Strategies:
 *   1. Construct CDN URL from collection + product name and HEAD-check
 *   2. Find a same-name sibling in another collection that has a unique CDN image
 *   3. For cross-referenced /uploads/ paths, try CDN URL construction
 *
 * Usage:
 *   node backend/scripts/msi-fix-shared-images.cjs --dry-run   # Preview only
 *   node backend/scripts/msi-fix-shared-images.cjs             # Execute
 *   node backend/scripts/msi-fix-shared-images.cjs --category "LVP (Plank)"  # One category
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const CDN = 'https://cdn.msisurfaces.com/images';

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

// Run HEAD checks with concurrency limit
async function headBatch(urls, concurrency = 10) {
  const results = new Array(urls.length).fill(null);
  let idx = 0;

  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      results[i] = await headUrl(urls[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}

// Clean product name: strip dimension suffixes, "Res." prefix, etc.
function cleanName(name) {
  return name
    .replace(/[-\s]*\d+\/\d+-\d+mm\s*$/i, '')        // "-1/2-2mm"
    .replace(/[-\s]*[\d.]+x[\d.]+-\d+\/\d+-\d+mm$/i, '') // "7.48x74.8-1/2-2mm"
    .replace(/[-\s]*[\d.]+x[\d.]+\s*$/i, '')           // trailing dimensions
    .replace(/\s*-\s*$/, '')                             // trailing dash
    .trim();
}

// Generate candidate CDN URLs for a product based on its category
function generateCandidateUrls(name, collection, category, displayName) {
  const cleaned = cleanName(name);
  const nameSlug = slugify(cleaned);
  const collSlug = collection ? slugify(collection) : '';
  const dispSlug = displayName ? slugify(cleanName(displayName)) : nameSlug;
  const urls = [];

  // Handle "Res." prefix → strip it and also try with "-resrve" suffix
  const isReserve = /^Res\.\s+/i.test(cleaned);
  const baseNameNoRes = isReserve ? cleaned.replace(/^Res\.\s+/i, '').trim() : null;
  const baseSlugNoRes = baseNameNoRes ? slugify(baseNameNoRes) : null;

  if (category === 'LVP (Plank)' || category === 'Waterproof Wood' || category === 'Engineered Hardwood') {
    // LVP pattern: /lvt/detail/{collection}-{name}-vinyl-flooring.jpg

    // Reserve products: {name-without-res}-resrve-vinyl-flooring.jpg
    if (baseSlugNoRes) {
      urls.push(`${CDN}/lvt/detail/${baseSlugNoRes}-resrve-vinyl-flooring.jpg`);
      urls.push(`${CDN}/lvt/detail/${baseSlugNoRes}-reserve-vinyl-flooring.jpg`);
      urls.push(`${CDN}/lvt/detail/reserve-${baseSlugNoRes}-vinyl-flooring.jpg`);
      if (collSlug) {
        urls.push(`${CDN}/lvt/detail/${collSlug}-${baseSlugNoRes}-vinyl-flooring.jpg`);
      }
      urls.push(`${CDN}/colornames/${baseSlugNoRes}-resrve.jpg`);
      urls.push(`${CDN}/colornames/${baseSlugNoRes}.jpg`);
    }

    if (collSlug) {
      urls.push(`${CDN}/lvt/detail/${collSlug}-${nameSlug}-vinyl-flooring.jpg`);
      urls.push(`${CDN}/lvt/detail/${nameSlug}-${collSlug}-vinyl-flooring.jpg`);
    }
    urls.push(`${CDN}/lvt/detail/${nameSlug}-vinyl-flooring.jpg`);
    // Also try with display name
    if (dispSlug !== nameSlug) {
      if (collSlug) urls.push(`${CDN}/lvt/detail/${collSlug}-${dispSlug}-vinyl-flooring.jpg`);
      urls.push(`${CDN}/lvt/detail/${dispSlug}-vinyl-flooring.jpg`);
    }
    // colornames fallback
    if (collSlug) urls.push(`${CDN}/colornames/${nameSlug}-${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }

  if (category === 'Porcelain Tile' || category === 'Large Format Tile') {
    // Try iso, detail, and base patterns
    if (collSlug) {
      urls.push(`${CDN}/porcelainceramic/iso/${collSlug}-${nameSlug}-iso.jpg`);
      urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-${collSlug}-iso.jpg`);
      urls.push(`${CDN}/porcelainceramic/${collSlug}-${nameSlug}-porcelain.jpg`);
      urls.push(`${CDN}/porcelainceramic/${nameSlug}-${collSlug}-porcelain.jpg`);
    }
    urls.push(`${CDN}/porcelainceramic/iso/${dispSlug}-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${dispSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${dispSlug}.jpg`);
    urls.push(`${CDN}/colornames/${dispSlug}.jpg`);
    urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }

  if (category === 'Natural Stone' || category === 'Marble Countertops' || category === 'Granite Countertops' || category === 'Quartzite Countertops') {
    urls.push(`${CDN}/colornames/${dispSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    urls.push(`${CDN}/natural-stone/detail/${nameSlug}.jpg`);
    urls.push(`${CDN}/natural-stone/${nameSlug}.jpg`);
    if (collSlug) {
      urls.push(`${CDN}/colornames/${nameSlug}-${collSlug}.jpg`);
      urls.push(`${CDN}/colornames/${collSlug}-${nameSlug}.jpg`);
    }
  }

  if (category === 'Mosaic Tile' || category === 'Backsplash Tile' || category === 'Backsplash & Wall Tile') {
    urls.push(`${CDN}/mosaics/variations/${dispSlug}.jpg`);
    urls.push(`${CDN}/mosaics/variations/${nameSlug}.jpg`);
    urls.push(`${CDN}/mosaics/${dispSlug}.jpg`);
    urls.push(`${CDN}/mosaics/${nameSlug}.jpg`);
    urls.push(`${CDN}/colornames/${dispSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    if (collSlug) {
      urls.push(`${CDN}/mosaics/variations/${nameSlug}-${collSlug}.jpg`);
      urls.push(`${CDN}/colornames/${nameSlug}-${collSlug}.jpg`);
    }
  }

  if (category === 'Hardscaping' || category === 'Stacked Stone' || category === 'Pavers') {
    urls.push(`${CDN}/hardscaping/detail/${dispSlug}.jpg`);
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}.jpg`);
    urls.push(`${CDN}/hardscaping/${dispSlug}.jpg`);
    urls.push(`${CDN}/hardscaping/${nameSlug}.jpg`);
    if (collSlug) {
      urls.push(`${CDN}/hardscaping/detail/${nameSlug}-${collSlug}.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${collSlug}-${nameSlug}.jpg`);
      urls.push(`${CDN}/porcelainceramic/${nameSlug}-${collSlug}-porcelain.jpg`);
    }
    urls.push(`${CDN}/porcelainceramic/${dispSlug}-porcelain.jpg`);
    urls.push(`${CDN}/colornames/${dispSlug}.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }

  if (category === 'Transitions & Moldings') {
    // T&M accessories share parent product image — try parent name patterns
    // Extract the base flooring name (strip trim code suffix)
    const trimMatch = name.match(/^(.+?)\s+(Ec|Ecl|Osn|Fsn|Fsnl|Qr|Srl?|St|Tl?|T-Sr|4-In-1|Rt)(?:-Ee|-Sr|-W)?\s+[\d.]+"?\s*$/i);
    const baseName = trimMatch ? trimMatch[1].trim() : name;
    const baseSlug = slugify(baseName);
    // Try common LVP parent collections
    for (const coll of ['prescott', 'cyrus', 'xl-cyrus', 'xl-prescott', 'andover', 'woodhills']) {
      urls.push(`${CDN}/lvt/detail/${coll}-${baseSlug}-vinyl-flooring.jpg`);
    }
    urls.push(`${CDN}/lvt/detail/${baseSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/colornames/${baseSlug}.jpg`);
  }

  // Deduplicate
  return [...new Set(urls)];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMSI Shared Image Fix${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (CATEGORY_FILTER) console.log(`Category filter: "${CATEGORY_FILTER}"`);
  console.log('='.repeat(60) + '\n');

  const client = await pool.connect();

  try {
    if (!DRY_RUN) await client.query('BEGIN');

    // 1. Get MSI vendor
    const { rows: [vendor] } = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    if (!vendor) { console.log('ERROR: MSI vendor not found'); return; }

    // 2. Find all products with shared primary images (optimized: 2-step query)
    const allMsiMedia = await client.query(`
      SELECT p.id as product_id, p.name, p.display_name, p.collection, c.name as category,
             m.url as current_url, m.id as media_id
      FROM media_assets m
      JOIN products p ON p.id = m.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE v.code = 'MSI' AND m.asset_type = 'primary' AND m.sku_id IS NULL AND p.status = 'active'
      ${CATEGORY_FILTER ? "AND c.name = $1" : ""}
      ORDER BY c.name, p.collection, p.name
    `, CATEGORY_FILTER ? [CATEGORY_FILTER] : []);

    // Count URL usage
    const urlShareCount = new Map();
    for (const r of allMsiMedia.rows) {
      urlShareCount.set(r.current_url, (urlShareCount.get(r.current_url) || 0) + 1);
    }

    // Filter to only shared ones
    const sharedProducts = allMsiMedia.rows
      .filter(r => urlShareCount.get(r.current_url) > 1)
      .map(r => ({ ...r, share_count: urlShareCount.get(r.current_url) }));

    console.log(`Products with shared images: ${sharedProducts.length}\n`);
    if (sharedProducts.length === 0) {
      console.log('Nothing to fix.');
      return;
    }

    // Category breakdown
    const catCounts = {};
    for (const p of sharedProducts) {
      catCounts[p.category] = (catCounts[p.category] || 0) + 1;
    }
    console.log('By category:');
    for (const [cat, cnt] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${cnt}`);
    }
    console.log();

    // 3. Build map of all MSI products by name (for sibling fallback)
    const { rows: allProducts } = await client.query(`
      SELECT p.id, p.name, p.collection, c.name as category, m.url as img_url
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN media_assets m ON m.product_id = p.id AND m.asset_type = 'primary' AND m.sku_id IS NULL
      WHERE v.code = 'MSI' AND p.status = 'active'
    `);

    // Index by lowercase name → array of products
    const nameIndex = new Map();
    for (const p of allProducts) {
      const key = p.name.toLowerCase().trim();
      if (!nameIndex.has(key)) nameIndex.set(key, []);
      nameIndex.get(key).push(p);
    }

    // 4. Process each shared-image product
    let fixed = 0, unfixed = 0, siblingFixed = 0;
    let totalProbes = 0;
    const unfixedList = [];

    // Group by category for cleaner output
    const byCategory = new Map();
    for (const p of sharedProducts) {
      if (!byCategory.has(p.category)) byCategory.set(p.category, []);
      byCategory.get(p.category).push(p);
    }

    // Pre-compute existing URL usage counts to avoid N+1 queries
    const { rows: urlCounts } = await client.query(`
      SELECT url, COUNT(DISTINCT product_id) as cnt
      FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NULL
      GROUP BY url HAVING COUNT(DISTINCT product_id) > 1
    `);
    const urlUsageMap = new Map(urlCounts.map(r => [r.url, parseInt(r.cnt)]));

    for (const [category, products] of byCategory) {
      console.log(`\n--- ${category} (${products.length} products) ---`);

      // Generate all candidate URLs for all products in this category
      const productUrls = products.map(p => ({
        product: p,
        candidates: generateCandidateUrls(p.name, p.collection, p.category, p.display_name),
      }));

      // Collect ALL unique candidate URLs across all products
      const allCandidateUrls = new Set();
      for (const { candidates } of productUrls) {
        for (const url of candidates) allCandidateUrls.add(url);
      }

      // Batch HEAD-check all candidate URLs at once (concurrency=20)
      const urlList = [...allCandidateUrls];
      totalProbes += urlList.length;
      console.log(`  Checking ${urlList.length} candidate URLs...`);

      const validUrls = new Set();
      // Process in chunks of 20 concurrent requests
      for (let i = 0; i < urlList.length; i += 20) {
        const batch = urlList.slice(i, i + 20);
        const results = await Promise.all(batch.map(url => headUrl(url)));
        for (const result of results) {
          if (result) validUrls.add(result);
        }
      }
      console.log(`  Found ${validUrls.size} valid CDN URLs`);

      // Now match products to their best valid URL
      for (const { product, candidates } of productUrls) {
        let foundUrl = null;

        // Strategy 1: First valid candidate that isn't already heavily shared
        for (const url of candidates) {
          if (!validUrls.has(url)) continue;
          const usage = urlUsageMap.get(url) || 0;
          if (usage < 3) {
            foundUrl = url;
            break;
          }
        }

        // Strategy 2: Find sibling in different collection with unique CDN image
        if (!foundUrl) {
          const cleanedName = cleanName(product.name);
          const siblings = nameIndex.get(cleanedName.toLowerCase().trim()) || [];
          for (const sib of siblings) {
            if (sib.id === product.id) continue;
            if (!sib.img_url || !sib.img_url.includes('cdn.msisurfaces.com')) continue;
            const usage = urlUsageMap.get(sib.img_url) || 0;
            if (usage <= 2) {
              foundUrl = sib.img_url;
              siblingFixed++;
              break;
            }
          }
        }

        if (foundUrl) {
          fixed++;
          const shortUrl = foundUrl.replace('https://cdn.msisurfaces.com/images/', '');
          console.log(`  ✓ ${product.name} [${product.collection}] → ${shortUrl}`);

          if (!DRY_RUN) {
            await client.query(
              `UPDATE media_assets SET url = $1, original_url = $2 WHERE id = $3`,
              [foundUrl, foundUrl, product.media_id]
            );
          }
        } else {
          unfixed++;
          unfixedList.push(`  ${product.name} [${product.collection}] (shared with ${product.share_count} products)`);
        }
      }
    }

    // 5. Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  Total products with shared images: ${sharedProducts.length}`);
    console.log(`  Fixed via CDN lookup:              ${fixed - siblingFixed}`);
    console.log(`  Fixed via sibling image:           ${siblingFixed}`);
    console.log(`  Total fixed:                       ${fixed}`);
    console.log(`  Still unfixed:                     ${unfixed}`);
    console.log(`  Total HEAD probes:                 ${totalProbes}`);

    if (unfixedList.length > 0) {
      const show = unfixedList.slice(0, 50);
      console.log(`\nUnfixed products${unfixedList.length > 50 ? ` (showing 50 of ${unfixedList.length})` : ''}:`);
      for (const line of show) console.log(line);
    }

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log('\nAll changes committed.');
    } else {
      console.log('\nDry run complete - no changes made.');
    }

  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK');
    console.error('\nError:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
