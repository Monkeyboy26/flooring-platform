#!/usr/bin/env node
/**
 * MSI Image Coverage — achieve total image coverage for MSI products.
 *
 * Phase 1: Fix lifestyle-as-primary images (swap with product shots)
 * Phase 2: T&M trim → copy images from siblings / floor products
 * Phase 3: Scrape MSI website for remaining products without images
 * Phase 4: Report coverage stats
 *
 * Usage:
 *   node backend/scripts/msi-image-coverage.cjs --dry-run
 *   node backend/scripts/msi-image-coverage.cjs
 *   node backend/scripts/msi-image-coverage.cjs --phase 2
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const PHASE_ONLY = process.argv.includes('--phase')
  ? parseInt(process.argv[process.argv.indexOf('--phase') + 1])
  : null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

function log(label, value) {
  console.log(`  ${String(label).padEnd(52)} ${value}`);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Phase 1: Fix lifestyle-as-primary ──────────────────────────────────

async function phase1(client, vid) {
  console.log('\n=== Phase 1: Fix lifestyle-as-primary images ===');

  // Find products where primary image is a roomscene/vignette
  const { rows: badPrimaries } = await client.query(`
    SELECT ma.id AS primary_id, ma.product_id, ma.sort_order AS primary_sort,
           ma.url AS primary_url, ma.original_url AS primary_orig,
           p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND ma.asset_type = 'primary'
      AND (ma.original_url LIKE '%roomscene%' OR ma.original_url LIKE '%vignette%'
           OR ma.original_url LIKE '%lifestyle%')
  `, [vid]);

  let fixed = 0;
  for (const bp of badPrimaries) {
    // Find best product shot among alternates
    const { rows: alts } = await client.query(`
      SELECT id, sort_order, url, original_url
      FROM media_assets
      WHERE product_id = $1 AND asset_type != 'primary'
        AND original_url IS NOT NULL
        AND original_url NOT LIKE '%roomscene%'
        AND original_url NOT LIKE '%vignette%'
        AND original_url NOT LIKE '%lifestyle%'
      ORDER BY
        CASE
          WHEN original_url LIKE '%/detail/%' THEN 1
          WHEN original_url LIKE '%/colornames/%' THEN 2
          WHEN original_url LIKE '%/front/%' THEN 3
          WHEN original_url LIKE '%/iso/%' THEN 4
          WHEN original_url LIKE '%/edge/%' THEN 5
          ELSE 6
        END,
        sort_order
      LIMIT 1
    `, [bp.product_id]);

    if (alts.length > 0) {
      const alt = alts[0];
      // Swap: promote alternate to primary, demote primary to alternate
      // Use temp sort_order to avoid unique constraint violation
      await client.query(`UPDATE media_assets SET sort_order = 9999 WHERE id = $1`, [bp.primary_id]);
      await client.query(`UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`, [alt.id]);
      await client.query(`UPDATE media_assets SET asset_type = 'alternate', sort_order = $2 WHERE id = $1`, [bp.primary_id, alt.sort_order]);
      log(`"${bp.name}" primary swapped`, alt.original_url.split('/').pop());
      fixed++;
    } else {
      log(`"${bp.name}" — no product shot available`, 'skipped');
    }
  }

  log('Lifestyle-as-primary fixed:', fixed);
  return fixed;
}

// ─── Phase 2: T&M coverage via sibling/floor image copying ──────────────

async function phase2(client, vid) {
  console.log('\n=== Phase 2: T&M coverage via image copying ===');

  // Get T&M category ID
  const { rows: [tmCat] } = await client.query(
    `SELECT id FROM categories WHERE name = 'Transitions & Moldings' LIMIT 1`
  );
  if (!tmCat) { log('T&M category not found', ''); return 0; }

  let totalCopied = 0;

  // ─── Strategy A: Copy from T&M siblings (same base vendor_sku) ───
  console.log('\n  --- Strategy A: Copy from T&M siblings ---');
  const { rows: siblingCopies } = await client.query(`
    WITH tm_no_images AS (
      SELECT DISTINCT ON (p.id) p.id AS product_id,
        REGEXP_REPLACE(s.vendor_sku, '-[A-Z][-A-Z]*$', '') AS base_sku
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.vendor_sku LIKE 'VTT%'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ),
    tm_with_images AS (
      SELECT DISTINCT ON (REGEXP_REPLACE(s.vendor_sku, '-[A-Z][-A-Z]*$', ''))
        REGEXP_REPLACE(s.vendor_sku, '-[A-Z][-A-Z]*$', '') AS base_sku,
        ma.url, ma.original_url
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.vendor_sku LIKE 'VTT%'
      JOIN media_assets ma ON ma.product_id = p.id AND ma.asset_type = 'primary'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
      ORDER BY REGEXP_REPLACE(s.vendor_sku, '-[A-Z][-A-Z]*$', ''), ma.sort_order
    )
    SELECT tn.product_id, tw.url, tw.original_url
    FROM tm_no_images tn
    JOIN tm_with_images tw ON tw.base_sku = tn.base_sku
  `, [vid, tmCat.id]);

  for (const row of siblingCopies) {
    await client.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, 'primary', $2, $3, 0)
      ON CONFLICT DO NOTHING
    `, [row.product_id, row.url, row.original_url]);
  }
  log('Copied from T&M siblings:', siblingCopies.length);
  totalCopied += siblingCopies.length;

  // ─── Strategy B: Copy from floor products via VTT→VTR SKU mapping ───
  console.log('\n  --- Strategy B: Copy from floor products (VTT→VTR) ---');
  const { rows: floorCopies } = await client.query(`
    WITH tm_still_no_images AS (
      SELECT DISTINCT ON (p.id) p.id AS product_id,
        REPLACE(REGEXP_REPLACE(s.vendor_sku, '-[A-Z][-A-Z]*$', ''), 'VTT', '') AS product_code
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.vendor_sku LIKE 'VTT%'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ),
    floor_images AS (
      SELECT DISTINCT ON (REPLACE(REGEXP_REPLACE(s.vendor_sku, '\\d.*$', ''), 'VTR', ''))
        REPLACE(REGEXP_REPLACE(s.vendor_sku, '\\d.*$', ''), 'VTR', '') AS product_code,
        ma.url, ma.original_url
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.vendor_sku LIKE 'VTR%'
      JOIN media_assets ma ON ma.product_id = p.id AND ma.asset_type = 'primary'
      WHERE p.vendor_id = $1 AND p.status = 'active'
      ORDER BY REPLACE(REGEXP_REPLACE(s.vendor_sku, '\\d.*$', ''), 'VTR', ''), ma.sort_order
    )
    SELECT tn.product_id, fi.url, fi.original_url
    FROM tm_still_no_images tn
    JOIN floor_images fi ON fi.product_code = tn.product_code
  `, [vid, tmCat.id]);

  for (const row of floorCopies) {
    await client.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, 'primary', $2, $3, 0)
      ON CONFLICT DO NOTHING
    `, [row.product_id, row.url, row.original_url]);
  }
  log('Copied from floor products (VTR):', floorCopies.length);
  totalCopied += floorCopies.length;

  // ─── Strategy C: Copy from floor products via name matching ───
  // For T&M products still without images, try matching by the base product name
  // e.g., "Abingdale Ec 94"" base name = "Abingdale" → find "Abingdale" in LVP
  console.log('\n  --- Strategy C: Copy from floor products (name match) ---');
  const { rows: tmStillMissing } = await client.query(`
    SELECT p.id, p.name,
      REGEXP_REPLACE(p.name,
        '\\s+(Ec|Ecl|Fsn|Fsnl|Fsn-Ee|Fsnl-Ee|Osn|Qr|Sr|Srl|Tl?|T-Sr|St|St-Ee|Rt|Endcap|Ayla Endcap)\\s+.*$',
        '', 'i') AS base_name
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
  `, [vid, tmCat.id]);

  // Get all floor product images indexed by name
  const { rows: floorProducts } = await client.query(`
    SELECT DISTINCT ON (p.name) p.name, ma.url, ma.original_url
    FROM products p
    JOIN media_assets ma ON ma.product_id = p.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND p.category_id NOT IN ($2)
    ORDER BY p.name, ma.sort_order
  `, [vid, tmCat.id]);

  const floorByName = new Map();
  for (const fp of floorProducts) {
    floorByName.set(fp.name.toLowerCase(), fp);
  }

  let nameCopied = 0;
  for (const tm of tmStillMissing) {
    const baseName = tm.base_name.toLowerCase().trim();
    const match = floorByName.get(baseName);
    if (match) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $3, 0)
        ON CONFLICT DO NOTHING
      `, [tm.id, match.url, match.original_url]);
      nameCopied++;
    }
  }
  log('Copied from floor products (name match):', nameCopied);
  totalCopied += nameCopied;

  // Report what's still missing
  const { rows: [{ cnt: stillMissing }] } = await client.query(`
    SELECT COUNT(*) AS cnt FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
  `, [vid, tmCat.id]);
  log('T&M products still without images:', stillMissing);
  log('Total T&M images copied:', totalCopied);
  return totalCopied;
}

// ─── Phase 3: Scrape MSI website for remaining products ─────────────────

const BASE_URL = 'https://www.msisurfaces.com';
const CDN_BASE = 'https://cdn.msisurfaces.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCRAPE_DELAY = 1500;

const CATEGORY_PAGES = [
  '/porcelain-tile/', '/marble-tile/', '/travertine-tile/',
  '/granite-tile/', '/quartzite-tile/', '/slate-tile/',
  '/sandstone-tile/', '/limestone-tile/', '/onyx-tile/',
  '/wood-look-tile-and-planks/', '/large-format-tile/',
  '/luxury-vinyl-flooring/', '/waterproof-hybrid-rigid-core/',
  '/w-luxury-genuine-hardwood/',
  '/hardscape/rockmount-stacked-stone/', '/hardscape/arterra-porcelain-pavers/',
  '/hardscape/cobbles/', '/hardscape/stepping-stones/',
  '/hardscape/pavers/', '/hardscape/outdoor-tile/',
  '/mosaics/collections-mosaics/',
  '/backsplash-tile/subway-tile/', '/backsplash-tile/glass-tile/',
  '/backsplash-tile/geometric-pattern/', '/backsplash-tile/stacked-stone-collection/',
  '/backsplash-tile/encaustic-pattern/', '/backsplash-tile/specialty-shapes-wall-tile/',
  '/backsplash-tile/rio-lago-pebbles-mosaics/', '/backsplash-tile/waterjet-cut-mosaics/',
  '/backsplash-tile/acoustic-wood-slat/',
  '/stacked-stone/',
  '/quartz-countertops/', '/granite-countertops/',
  '/marble-countertops/', '/quartzite-countertops/',
  // Trim/accessories
  '/trim-and-accessories/', '/trim-accessories/',
  '/luxury-vinyl-flooring/trim-accessories/',
  '/waterproof-wood-flooring/woodhills/',
];

async function fetchText(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    return resp.text();
  } catch { return null; }
}

async function fetchSitemapUrls() {
  console.log('  Fetching sitemap...');
  const xml = await fetchText(`${BASE_URL}/sitemap.xml`);
  if (!xml) { console.log('  Failed to fetch sitemap.xml'); return []; }

  const urls = [];
  const locRegex = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/g;
  let m;
  while ((m = locRegex.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }

  const productUrls = urls.filter(u => {
    const path = new URL(u).pathname;
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    if (/\.(aspx|html)$/i.test(path)) return false;
    if (/\/(corporate|news|blog|locations|site-search|dealer|customer|vendor|room-visualizer|inspiration|merchandising|faq|privacy|brochures|flyers|silica|radon|sds|helpful|right-to|msivideo|slabphoto|linktomsi|msi-retailer|new-products|shopping)/i.test(path)) return false;
    return true;
  });
  console.log(`  Sitemap: ${urls.length} total, ${productUrls.length} product pages`);
  return productUrls;
}

async function fetchCategoryLinks(categoryPath) {
  const html = await fetchText(`${BASE_URL}${categoryPath}`);
  if (!html) return [];
  const urls = new Set();
  const linkRegex = /href="(\/[^"]+\/[^"]+\/)"/g;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const path = m[1];
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos?|warranty|care|cleaning|about|how-to|design-trends|site-search|corporate|news|blog)\/?$/i.test(path)) continue;
    if (/\.(aspx|html|pdf|jpg|png)$/i.test(path)) continue;
    const last = segments[segments.length - 1];
    if (/^\d+\s*[-x]\s*\d+/.test(last)) continue;
    urls.add(`${BASE_URL}${path}`);
  }
  return [...urls];
}

function imageScore(url) {
  const lower = url.toLowerCase();
  if (lower.includes('/detail/') || lower.includes('/colornames/')) return 100;
  if (lower.includes('/front/')) return 80;
  if (lower.includes('/iso/')) return 60;
  if (lower.includes('/edge/')) return 50;
  if (lower.includes('/vignette/')) return 40;
  if (lower.includes('/variations/')) return 35;
  if (lower.includes('/trims/')) return 30; // Don't exclude trims — they're product images!
  if (lower.includes('/roomscenes/')) return 20;
  if (lower.includes('/thumbnails/')) return 1;
  return 30;
}

function extractProductData(html) {
  const data = { images: [], skuCodes: [], name: '' };

  // Product name from <h1>
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match) {
    data.name = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  // SKU codes: ID#: XXXXX pattern
  const skuRegex = /ID#:\s*([A-Z0-9][-A-Z0-9]{4,})/gi;
  let m;
  while ((m = skuRegex.exec(html)) !== null) {
    const code = m[1].toUpperCase();
    if (!data.skuCodes.includes(code)) {
      data.skuCodes.push(code);
    }
  }

  // CDN image URLs
  const imgRegex = /https?:\/\/cdn\.msisurfaces\.com\/images\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    const imgUrl = m[0].replace(/&amp;/g, '&');
    if (!data.images.includes(imgUrl)) {
      data.images.push(imgUrl);
    }
  }

  // Sort by quality score
  data.images.sort((a, b) => imageScore(b) - imageScore(a));

  // Filter out junk
  data.images = data.images.filter(u => {
    const lower = u.toLowerCase();
    if (lower.includes('/thumbnails/')) return false;
    if (lower.includes('/miscellaneous/')) return false;
    if (lower.includes('/flyers/')) return false;
    if (lower.includes('/brochures/')) return false;
    if (/icon|logo|badge|placeholder|roomvo|wetcutting/i.test(lower)) return false;
    return true;
  });

  return data;
}

async function phase3(db, vid) {
  console.log('\n=== Phase 3: Scrape MSI website for remaining products ===');

  // Load products needing images (db = pool for autocommit)
  const { rows: needsImages } = await db.query(`
    SELECT p.id AS product_id, p.name, p.collection,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.vendor_sku IS NOT NULL) AS vendor_skus,
           array_agg(DISTINCT s.internal_sku) FILTER (WHERE s.internal_sku IS NOT NULL) AS internal_skus
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.name
  `, [vid]);

  console.log(`  Products still needing images: ${needsImages.length}`);
  if (needsImages.length === 0) {
    log('All MSI products have images!', '');
    return 0;
  }

  // Build SKU lookup maps
  const skuToProduct = new Map();
  for (const row of needsImages) {
    for (const sku of (row.vendor_skus || [])) {
      skuToProduct.set(sku.toUpperCase(), row);
    }
    for (const sku of (row.internal_skus || [])) {
      skuToProduct.set(sku.toUpperCase(), row);
      const withoutPrefix = sku.replace(/^MSI-/i, '').toUpperCase();
      skuToProduct.set(withoutPrefix, row);
    }
  }

  // Name lookup for fuzzy matching
  const nameToProduct = new Map();
  for (const row of needsImages) {
    const norm = row.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.length >= 4) nameToProduct.set(norm, row);
  }
  console.log(`  SKU lookup: ${skuToProduct.size} entries, Name lookup: ${nameToProduct.size} entries`);

  // Collect product URLs
  console.log('\n  --- Collecting product URLs ---');
  const allUrls = new Set();

  const sitemapUrls = await fetchSitemapUrls();
  sitemapUrls.forEach(u => allUrls.add(u));

  for (const cat of CATEGORY_PAGES) {
    try {
      const urls = await fetchCategoryLinks(cat);
      if (urls.length > 0) {
        console.log(`  ${cat} → ${urls.length} links`);
      }
      urls.forEach(u => allUrls.add(u));
      await delay(800);
    } catch (err) {
      console.log(`  ${cat} → ERROR: ${err.message}`);
    }
  }
  console.log(`  Total unique URLs to visit: ${allUrls.size}`);

  // Visit pages and match to DB
  let visited = 0;
  let matched = 0;
  let imagesSaved = 0;
  const matchedProductIds = new Set();

  console.log('\n  --- Scraping product pages ---');
  for (const url of allUrls) {
    visited++;

    try {
      const html = await fetchText(url);
      if (!html) continue;

      if (/too many requests|429|rate limit/i.test(html.slice(0, 1000))) {
        console.log(`  Rate limited, waiting 10s...`);
        await delay(10000);
        continue;
      }

      const data = extractProductData(html);
      if (data.images.length === 0) continue;

      // Match by SKU code
      let dbProd = null;
      for (const code of data.skuCodes) {
        dbProd = skuToProduct.get(code) || skuToProduct.get('MSI-' + code);
        if (dbProd) break;
      }

      // Fallback: match by name
      if (!dbProd && data.name) {
        const pageNameNorm = data.name
          .replace(/[®™©]/g, '')
          .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Vinyl|Tile|Plank|Flooring|Slab|Stone|Wood|Luxury|Stacked|Mosaic|Backsplash|Collection|Series)\b/gi, '')
          .toLowerCase().replace(/[^a-z0-9]/g, '');
        if (pageNameNorm.length >= 4) {
          dbProd = nameToProduct.get(pageNameNorm);
        }
      }

      if (!dbProd || matchedProductIds.has(dbProd.product_id)) continue;
      matchedProductIds.add(dbProd.product_id);

      // Save images (max 6: 1 primary + 5 alternates)
      const maxImages = Math.min(data.images.length, 6);
      for (let i = 0; i < maxImages; i++) {
        const imgUrl = data.images[i];
        const assetType = i === 0 ? 'primary'
          : (imgUrl.toLowerCase().includes('/roomscenes/') ? 'lifestyle' : 'alternate');

        await db.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, $2, $3, $3, $4)
          ON CONFLICT DO NOTHING
        `, [dbProd.product_id, assetType, imgUrl, i]);
        imagesSaved++;
      }
      matched++;

      if (matched % 50 === 0) {
        console.log(`  Progress: visited ${visited}/${allUrls.size}, matched ${matched}, images ${imagesSaved}`);
      }
    } catch {
      // Non-fatal
    }

    await delay(SCRAPE_DELAY);
  }

  log('Pages visited:', visited);
  log('Products matched:', matched);
  log('Images saved:', imagesSaved);
  return matched;
}

// ─── Phase 4: Junk image cleanup ──────────────────────────────────────────

async function phase4(client, vid) {
  console.log('\n=== Phase 4: Junk image cleanup ===');

  // Remove roomvo-light, miscellaneous safety labels, etc. from products that have real images
  const { rowCount: removedJunk } = await client.query(`
    DELETE FROM media_assets ma
    USING products p
    WHERE ma.product_id = p.id AND p.vendor_id = $1 AND p.status = 'active'
      AND (
        ma.url LIKE '%roomvo%' OR ma.url LIKE '%miscellaneous%'
        OR ma.url LIKE '%prop65%' OR ma.url LIKE '%cpsc%'
        OR ma.url LIKE '%warning%' OR ma.url LIKE '%wetcutting%'
        OR ma.url LIKE '%inspiration-gallery%'
      )
  `, [vid]);
  log('Removed junk/placeholder images:', removedJunk);

  // Fix asset_type for any primary images that point to safety labels or junk
  // (shouldn't happen after cleanup but just in case)

  return removedJunk;
}

// ─── Phase 5: Name-based image copying ──────────────────────────────────

function extractBaseName(name) {
  let base = name;

  // Strip T&M suffixes: "Aaron Ec 78" → "Aaron", "Brianka St-Ee 47" → "Brianka"
  // Common trim type codes: Ec, St, Fsn, T, Qr, Rt, Sr, Tl, Srl, Ecl, Fsnl
  // Often followed by "-Ee" or dimension like 78", 94", 47"
  base = base.replace(/\s+(Ec|Ecl|St|Fsn|Fsnl|T|Qr|Rt|Sr|Srl|Tl|T-Sr|Flsn|Endcap|End Cap)(\s*-?\s*Ee)?\s+[\d."]+$/i, '');

  // Strip trailing dimension like "94"", "78"", "47"", "14.75""
  base = base.replace(/\s+[\d.]+[""]?\s*$/, '');

  // Strip trailing trim type indicators
  base = base.replace(/\s+(Ec|Ecl|St|Fsn|Fsnl|T|Qr|Rt|Sr|Srl|Tl|T-Sr|Flsn|Endcap|End Cap)(\s*-?\s*Ee)?$/i, '');

  // Strip tile format suffixes: Bullnose, Mosaic, Bull Nose, R11, Hexagon, etc.
  base = base.replace(/\s+(Bullnose|Bull Nose|Mosaic|R11|Hexagon|Penny Round|Basketweave|Herringbone|Arabesque|Elongated Octagon|Framework|Picket|Lantern|Chevron|Subway)\s*/gi, ' ');

  // Strip finish suffixes (including truncated forms): Matte/Matt, Polished/Pol, Honed/Hon, etc.
  base = base.replace(/\s+(Matte?|Polished?|Honed?|Glossy?|Satin|Lappato|Rectified)\s*$/i, '');

  // Strip "3d" suffix
  base = base.replace(/\s+3d\s*$/i, '');

  // Strip "Mm" pattern: "9 Mm", "7mm", "4.5 Mm", "x8mm"
  base = base.replace(/[x\s]+\d+\.?\d*\s*mm\b/gi, '');

  // Strip size from name: "12X24", "24x24", "2x2", "2448", "6mm", etc.
  base = base.replace(/\s+\d+\.?\d*\s*[xX]\s*\d+\.?\d*/g, '');
  base = base.replace(/\s+\d{4,}\s*$/i, ''); // trailing 4+ digit sizes like "2448"

  // Strip quoted dimensions: 12"X12"X0.38", 28"X28"X2"
  base = base.replace(/\s*\d+[""]?\s*[xX]\s*\d+[""]?(\s*[xX]\s*[\d.]+[""]?)?\s*/g, ' ');

  // Strip hardscaping suffixes
  base = base.replace(/x\d+\.?\d*\s*(cm|in)?\b/gi, ''); // x3cm, x2cm without space
  base = base.replace(/\s*x\s*[\d.]+\s*(cm|in)?\s*/gi, '');
  base = base.replace(/\s+(Tumbled|Sandblasted|Flamed|Splitface|Split Face|Ledgestone|Ledger)\s*$/i, '');
  base = base.replace(/\s+(Coping|Copings?|Pavers?|Paver|Pool Cop|Stepping|Sill|Tread|Cap)\s*.*$/i, '');
  base = base.replace(/\s+(Hand Cut|Thick Hand)\s*.*$/i, '');
  base = base.replace(/\s+\d+-\d+(cm|in)\s*.*$/i, ''); // "3-5cm(1-2in) 40lb"

  // Strip stacked stone suffixes
  base = base.replace(/\s+(Corners?|Corner|Sq & Rec|Sq Rec|Sawn Ashlar|Ashlar|Veneer Fieldstone)\s*.*$/i, '');

  // Strip parenthetical content: "( 14 Pcs Per Box )"
  base = base.replace(/\s*\([^)]*\)\s*/g, '');

  // Strip trailing dimensions like "6x18", "3x6"
  base = base.replace(/\s+\d+x\d+\s*$/i, '');

  // Strip weight/quantity: "40lb", "50 Lb", "30lbs"
  base = base.replace(/\s+\d+\s*lbs?\b.*$/i, '');

  // Strip natural stone thickness: "x.38", "x0.62", "x3/8"
  base = base.replace(/x[\d./]+\s*/gi, '');

  // Strip "Prem" prefix
  base = base.replace(/^\(?(Prem|Std)\)?\s*/i, '');

  // Strip truncated finish at end: "P", "Pol", "Hon", "G"
  base = base.replace(/\s+(P|Pol|Polis|Hon|G|Hf)\s*$/i, '');

  // Clean up
  base = base.replace(/\s+/g, ' ').trim();

  return base;
}

async function phase5(client, vid) {
  console.log('\n=== Phase 5: Name-based image copying ===');

  // Get all MSI products with their images status
  const { rows: allProducts } = await client.query(`
    SELECT p.id, p.name, p.collection, c.name AS category,
      EXISTS(
        SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id
        AND ma.url NOT LIKE '%roomvo%' AND ma.url NOT LIKE '%miscellaneous%'
        AND ma.url NOT LIKE '%prop65%' AND ma.url NOT LIKE '%cpsc%'
        AND ma.url NOT LIKE '%warning%' AND ma.url NOT LIKE '%wetcutting%'
        AND ma.url NOT LIKE '%inspiration%' AND ma.url NOT LIKE '%svg%'
      ) AS has_real_img
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.name
  `, [vid]);

  // Build lookup: base_name → products with images
  const baseNameToImaged = new Map();
  const missing = [];

  for (const p of allProducts) {
    const base = extractBaseName(p.name);
    if (p.has_real_img) {
      if (!baseNameToImaged.has(base)) baseNameToImaged.set(base, []);
      baseNameToImaged.get(base).push(p);
    } else {
      missing.push({ ...p, baseName: base });
    }
  }

  console.log(`  Products with real images: ${allProducts.length - missing.length}`);
  console.log(`  Products needing images: ${missing.length}`);
  console.log(`  Unique base names with images: ${baseNameToImaged.size}`);

  let copied = 0;
  let unmatched = 0;
  const unmatchedExamples = [];

  for (const m of missing) {
    // Try exact base name match
    let donors = baseNameToImaged.get(m.baseName);

    // Try prefix matching if no exact match
    if (!donors) {
      const words = m.baseName.split(' ');
      for (let len = words.length; len >= 2; len--) {
        const prefix = words.slice(0, len).join(' ');
        donors = baseNameToImaged.get(prefix);
        if (donors) break;
      }
    }

    // Try single-word match for short names (e.g., "Aaron" → "Aaron")
    if (!donors && m.baseName.split(' ').length === 1 && m.baseName.length >= 4) {
      donors = baseNameToImaged.get(m.baseName);
    }

    // Try matching the raw first word for T&M products
    if (!donors && m.category === 'Transitions & Moldings') {
      const firstName = m.name.split(/\s+/)[0];
      if (firstName.length >= 4) {
        for (const [base, prods] of baseNameToImaged) {
          if (base.split(/\s+/)[0] === firstName) {
            donors = prods;
            break;
          }
        }
      }
      // Try first two words
      if (!donors) {
        const firstTwo = m.name.split(/\s+/).slice(0, 2).join(' ');
        if (firstTwo.length >= 5) {
          for (const [base, prods] of baseNameToImaged) {
            if (base.startsWith(firstTwo)) {
              donors = prods;
              break;
            }
          }
        }
      }
    }

    // Try matching by display_name LIKE prefix (any product, not just T&M)
    if (!donors && m.baseName.length >= 5) {
      for (const [base, prods] of baseNameToImaged) {
        // Either the base starts with our name or our name starts with the base
        if (base.startsWith(m.baseName) || m.baseName.startsWith(base)) {
          donors = prods;
          break;
        }
      }
    }

    // Try first two words for any category
    if (!donors) {
      const firstTwo = m.baseName.split(/\s+/).slice(0, 2).join(' ');
      if (firstTwo.length >= 5) {
        for (const [base, prods] of baseNameToImaged) {
          if (base.startsWith(firstTwo) || firstTwo.startsWith(base)) {
            donors = prods;
            break;
          }
        }
      }
    }

    if (!donors || donors.length === 0) {
      unmatched++;
      if (unmatchedExamples.length < 30) {
        unmatchedExamples.push({ name: m.name, base: m.baseName, category: m.category });
      }
      continue;
    }

    // Pick best donor (prefer same collection)
    const donor = donors.find(d => d.collection === m.collection) || donors[0];

    // Copy images from donor
    const { rows: donorImages } = await client.query(`
      SELECT url, original_url, asset_type, sort_order
      FROM media_assets
      WHERE product_id = $1
        AND url NOT LIKE '%roomvo%' AND url NOT LIKE '%miscellaneous%'
        AND url NOT LIKE '%prop65%' AND url NOT LIKE '%cpsc%'
        AND url NOT LIKE '%warning%' AND url NOT LIKE '%wetcutting%'
        AND url NOT LIKE '%inspiration%' AND url NOT LIKE '%svg%'
      ORDER BY sort_order
      LIMIT 4
    `, [donor.id]);

    if (donorImages.length === 0) continue;

    for (const img of donorImages) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [m.id, img.asset_type, img.url, img.original_url || img.url, img.sort_order]);
    }
    copied++;

    if (copied % 100 === 0) {
      console.log(`  Progress: ${copied} products copied, ${unmatched} unmatched`);
    }
  }

  log('Products with images copied:', copied);
  log('Products still unmatched:', unmatched);

  if (unmatchedExamples.length > 0) {
    console.log('\n  Sample unmatched products:');
    for (const ex of unmatchedExamples.slice(0, 20)) {
      log(`  "${ex.name}" (base: "${ex.base}")`, ex.category || '(none)');
    }
  }

  return copied;
}

// ─── Phase 6: Listing page scrape → CDN image matching ──────────────────

const LISTING_PAGES = [
  '/porcelain-tile/', '/marble-tile/', '/travertine-tile/',
  '/granite-tile/', '/quartzite-tile/', '/slate-tile/',
  '/sandstone-tile/', '/limestone-tile/', '/onyx-tile/',
  '/wood-look-tile-and-planks/', '/large-format-tile/',
  '/luxury-vinyl-flooring/', '/waterproof-hybrid-rigid-core/',
  '/w-luxury-genuine-hardwood/',
  '/hardscape/rockmount-stacked-stone/', '/hardscape/arterra-porcelain-pavers/',
  '/hardscape/cobbles/', '/hardscape/stepping-stones/',
  '/hardscape/pavers/', '/hardscape/outdoor-tile/',
  '/mosaics/collections-mosaics/',
  '/backsplash-tile/subway-tile/', '/backsplash-tile/glass-tile/',
  '/backsplash-tile/geometric-pattern/', '/backsplash-tile/stacked-stone-collection/',
  '/backsplash-tile/encaustic-pattern/', '/backsplash-tile/specialty-shapes-wall-tile/',
  '/backsplash-tile/rio-lago-pebbles-mosaics/', '/backsplash-tile/waterjet-cut-mosaics/',
  '/backsplash-tile/acoustic-wood-slat/',
  '/stacked-stone/',
  '/quartz-countertops/', '/granite-countertops/',
  '/marble-countertops/', '/quartzite-countertops/',
  '/waterproof-wood-flooring/woodhills/',
  // Trim pages
  '/luxury-vinyl-flooring/trim-accessories/',
  '/trim-and-accessories/', '/trim-accessories/',
];

function extractListingPairs(html) {
  const pairs = [];

  // Extract thumbnail URLs with positions
  const imgRegex = /cdn\.msisurfaces\.com\/images\/[^"'\s>]+\.(?:jpg|png|webp)/gi;
  const imgs = [];
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    const url = m[0];
    if (/roomvo|miscellaneous|banner|logo|svg|video|everlife|prop65|warning|wetcutting|cpsc/i.test(url)) continue;
    imgs.push({ url: 'https://' + url, pos: m.index });
  }

  // Extract product titles with positions
  const titleRegex = /product-title[^>]*>\s*([A-Z][^<]{2,60})/g;
  while ((m = titleRegex.exec(html)) !== null) {
    const name = m[1].trim();
    if (name.length < 3 || name.length > 60) continue;
    if (/^(img|display|position|block|font|text|margin|padding|width|height)/i.test(name)) continue;

    // Find closest preceding image
    let closest = null;
    for (const img of imgs) {
      if (img.pos < m.index && (!closest || img.pos > closest.pos)) {
        closest = img;
      }
    }
    if (closest) {
      pairs.push({ name, thumbUrl: closest.url });
    }
  }

  return pairs;
}

async function phase6(db, vid) {
  console.log('\n=== Phase 6: Listing page scrape + CDN matching ===');

  // Get remaining products without images
  const { rows: stillMissing } = await db.query(`
    SELECT p.id, p.name, p.collection, c.name AS category
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ORDER BY p.name
  `, [vid]);

  console.log(`  Products still missing images: ${stillMissing.length}`);
  if (stillMissing.length === 0) return 0;

  // Build name lookup: normalized name → product
  const nameToProduct = new Map();
  for (const p of stillMissing) {
    const base = extractBaseName(p.name);
    const norm = base.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.length >= 3) nameToProduct.set(norm, p);

    // Also index by first 2 words
    const words = base.split(/\s+/);
    if (words.length >= 2) {
      const two = words.slice(0, 2).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!nameToProduct.has(two)) nameToProduct.set(two, p);
    }
  }

  // Step 1: Scrape listing pages and collect name → thumbnail pairs
  console.log('\n  --- Scraping listing pages ---');
  const allPairs = new Map(); // name → thumbUrl (dedup by name)

  for (const path of LISTING_PAGES) {
    try {
      const html = await fetchText(`${BASE_URL}${path}`);
      if (!html) continue;
      const pairs = extractListingPairs(html);
      if (pairs.length > 0) {
        let newCount = 0;
        for (const p of pairs) {
          const key = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!allPairs.has(key)) {
            allPairs.set(key, p);
            newCount++;
          }
        }
        console.log(`  ${path} → ${pairs.length} products (${newCount} new)`);
      }
      await delay(800);
    } catch (err) {
      console.log(`  ${path} → ERROR: ${err.message}`);
    }
  }

  console.log(`  Total unique products from listings: ${allPairs.size}`);

  // Step 2: Match listing products to our DB products, upgrade to high-res URLs
  console.log('\n  --- Matching to DB products ---');
  let matched = 0;
  let imagesSaved = 0;
  const matchedIds = new Set();

  for (const [normName, pair] of allPairs) {
    // Find matching DB product
    let dbProd = nameToProduct.get(normName);

    // Try partial match: first 2 words
    if (!dbProd) {
      for (const [key, prod] of nameToProduct) {
        if (key.startsWith(normName) || normName.startsWith(key)) {
          dbProd = prod;
          break;
        }
      }
    }

    if (!dbProd || matchedIds.has(dbProd.id)) continue;
    matchedIds.add(dbProd.id);

    // Get the thumbnail URL and try high-res versions
    const thumbUrl = pair.thumbUrl;
    const slug = thumbUrl.split('/').pop().replace(/\.(jpg|png|webp)$/i, '');
    const section = thumbUrl.match(/images\/([^/]+)\//)?.[1] || 'porcelainceramic';
    const ext = thumbUrl.match(/\.(jpg|png|webp)$/i)?.[1] || 'jpg';

    // Try: root (highest quality), then iso, then thumbnail
    const candidates = [
      `https://cdn.msisurfaces.com/images/${section}/${slug}.${ext}`,
      `https://cdn.msisurfaces.com/images/${section}/iso/${slug}-iso.${ext}`,
      `https://cdn.msisurfaces.com/images/${section}/iso/${slug}.${ext}`,
      thumbUrl, // fallback to thumbnail
    ];

    let primaryUrl = null;
    const altUrls = [];

    for (const url of candidates) {
      if (url === thumbUrl) {
        // Thumbnail always works (we got it from the page)
        if (!primaryUrl) primaryUrl = url;
        else altUrls.push(url);
        continue;
      }
      try {
        const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          if (!primaryUrl) primaryUrl = url;
          else altUrls.push(url);
        }
      } catch {}
    }

    if (!primaryUrl) continue;

    // Save primary
    await db.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, 'primary', $2, $2, 0)
      ON CONFLICT DO NOTHING
    `, [dbProd.id, primaryUrl]);
    imagesSaved++;

    // Save alternates
    for (let i = 0; i < altUrls.length && i < 3; i++) {
      await db.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'alternate', $2, $2, $3)
        ON CONFLICT DO NOTHING
      `, [dbProd.id, altUrls[i], i + 1]);
      imagesSaved++;
    }

    matched++;
    if (matched % 25 === 0) {
      console.log(`  Progress: ${matched} products matched, ${imagesSaved} images saved`);
    }
    await delay(100);
  }

  // Step 3: For remaining products, try direct CDN probing
  const stillMissing2 = stillMissing.filter(p => !matchedIds.has(p.id));
  if (stillMissing2.length > 0 && stillMissing2.length < 500) {
    console.log(`\n  --- CDN probing for ${stillMissing2.length} remaining products ---`);
    let probeMatched = 0;

    for (const p of stillMissing2) {
      const base = extractBaseName(p.name);
      const words = base.split(/\s+/).filter(w => w.length >= 2);
      if (words.length < 2) continue;

      // Generate slug candidates: color-series pattern
      const slugs = new Set();
      // Reversed 2-word: "Ansello Grey" → "grey-ansello"
      slugs.add((words[1] + '-' + words[0]).toLowerCase());
      // Same order: "ansello-grey"
      slugs.add(words.join('-').toLowerCase());
      // Full name slugified
      slugs.add(base.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));

      const sections = ['porcelainceramic', 'colornames', 'hardscaping', 'mosaics', 'lvt'];
      const suffixes = ['-porcelain', '-ceramic', '-marble', '-granite', '-mosaic', ''];

      let foundUrl = null;
      outer:
      for (const slug of slugs) {
        for (const suffix of suffixes.slice(0, 3)) {
          for (const section of sections.slice(0, 2)) {
            const url = `https://cdn.msisurfaces.com/images/${section}/thumbnails/${slug}${suffix}.jpg`;
            try {
              const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
              if (resp.ok) {
                // Try high-res root version
                const rootUrl = `https://cdn.msisurfaces.com/images/${section}/${slug}${suffix}.jpg`;
                try {
                  const rootResp = await fetch(rootUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
                  foundUrl = rootResp.ok ? rootUrl : url;
                } catch {
                  foundUrl = url;
                }
                break outer;
              }
            } catch {}
          }
        }
      }

      if (foundUrl) {
        await db.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, 'primary', $2, $2, 0)
          ON CONFLICT DO NOTHING
        `, [p.id, foundUrl]);
        probeMatched++;
        matched++;
        imagesSaved++;
        if (probeMatched % 10 === 0) {
          console.log(`  CDN probe: ${probeMatched} found`);
        }
      }

      await delay(50);
    }
    log('CDN probe matches:', probeMatched);
  }

  log('Total products matched:', matched);
  log('Total images saved:', imagesSaved);
  return matched;
}

// ─── Phase 7: Report ────────────────────────────────────────────────────

async function phase7(db, vid) {
  console.log('\n=== Phase 7: Coverage Report ===');

  const { rows: [stats] } = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images,
      COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as without_images
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);

  const pct = (100 * stats.with_images / stats.total).toFixed(1);
  log('Total active products:', stats.total);
  log('Products with images:', stats.with_images);
  log('Products without images:', stats.without_images);
  log('Coverage:', pct + '%');

  // Breakdown by category
  const { rows: byCat } = await db.query(`
    SELECT COALESCE(c.name, '(uncategorized)') as category,
      COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as missing
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    GROUP BY c.name
    ORDER BY missing DESC
  `, [vid]);

  if (byCat.length > 0) {
    console.log('\n  Missing by category:');
    for (const r of byCat) {
      log(`  ${r.category}:`, r.missing);
    }
  }
}

// ─── Phase 8: CDN slug harvesting + systematic probing ──────────────────

async function phase8(db, vid) {
  console.log('\n=== Phase 8: CDN slug harvesting + systematic probing ===');

  // Step 1: Load all existing CDN URLs and extract slug patterns
  const { rows: existingMedia } = await db.query(`
    SELECT p.display_name, ma.url
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND ma.url LIKE '%cdn.msisurfaces.com%'
      AND ma.url NOT LIKE '%roomvo%' AND ma.url NOT LIKE '%miscellaneous%'
      AND ma.url NOT LIKE '%svg%' AND ma.url NOT LIKE '%banner%'
  `, [vid]);

  // Build name → CDN slug mapping from existing images
  // Extract the slug from URLs like:
  //   .../porcelainceramic/gris-adella-porcelain.jpg → "gris-adella-porcelain"
  //   .../lvt/front/ladson-wayland-7.5x75.jpg → "ladson-wayland"
  const nameToSlugs = new Map(); // normalized display_name → Set of slug stems

  for (const row of existingMedia) {
    const urlMatch = row.url.match(/cdn\.msisurfaces\.com\/images\/([^/]+)\/(?:[^/]+\/)?([^.]+)\./);
    if (!urlMatch) continue;
    const section = urlMatch[1];
    const slug = urlMatch[2]
      .replace(/-iso$/, '')
      .replace(/-edge$/, '')
      .replace(/-vignette$/, '')
      .replace(/-variation$/, '')
      .replace(/-(front|detail)$/, '')
      .replace(/-\d+x\d+.*$/, ''); // strip size suffixes

    const normName = row.display_name
      .replace(/\s+(Matte|Polished|Honed|Glossy|R11|Bullnose|Mosaic|Hexagon)\s*.*$/i, '')
      .replace(/\s+\d+\.?\d*\s*[xX]\s*\d+\.?\d*/g, '')
      .trim().toLowerCase();

    if (!nameToSlugs.has(normName)) nameToSlugs.set(normName, new Set());
    nameToSlugs.get(normName).add(`${section}/${slug}`);
  }
  console.log(`  Harvested slug patterns from ${existingMedia.length} existing images`);
  console.log(`  Unique name→slug mappings: ${nameToSlugs.size}`);

  // Step 2: Get remaining products without images
  const { rows: missing } = await db.query(`
    SELECT p.id, p.name, p.display_name, p.collection, c.name AS category
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ORDER BY p.name
  `, [vid]);

  console.log(`  Products still missing images: ${missing.length}`);
  if (missing.length === 0) return 0;

  let matched = 0;
  let probed = 0;

  // Step 3: For each missing product, try to find a CDN URL
  for (const p of missing) {
    const normName = p.display_name
      .replace(/\s+(Matte|Polished|Honed|Glossy|R11|Bullnose|Mosaic|Hexagon)\s*.*$/i, '')
      .replace(/\s+\d+\.?\d*\s*[xX]\s*\d+\.?\d*/g, '')
      .trim().toLowerCase();

    // Check if we have a known slug for this name
    const knownSlugs = nameToSlugs.get(normName);
    if (knownSlugs) {
      // Try the known slug patterns
      for (const sectionSlug of knownSlugs) {
        const [section, slug] = sectionSlug.split('/');
        const rootUrl = `https://cdn.msisurfaces.com/images/${section}/${slug}.jpg`;
        try {
          const resp = await fetch(rootUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (resp.ok) {
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, 'primary', $2, $2, 0)
              ON CONFLICT DO NOTHING
            `, [p.id, rootUrl]);
            matched++;
            if (matched % 25 === 0) console.log(`  Progress: ${matched} matched from known slugs`);
            break;
          }
        } catch {}
        probed++;
      }
      if (matched > 0 && nameToSlugs.get(normName)) continue;
    }

    // Step 4: Generate candidate slugs from the product name
    const words = normName.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 1) continue;

    // Determine CDN sections based on category (always include colornames as fallback)
    const cat = (p.category || '').toLowerCase();
    let sections;
    if (cat.includes('porcelain') || cat.includes('ceramic')) {
      sections = ['porcelainceramic', 'colornames'];
    } else if (cat.includes('hardscap') || cat.includes('stacked') || cat.includes('paver')) {
      sections = ['hardscaping', 'colornames'];
    } else if (cat.includes('mosaic')) {
      sections = ['mosaics', 'colornames'];
    } else if (cat.includes('lvp') || cat.includes('vinyl') || cat.includes('hardwood')) {
      sections = ['lvt', 'colornames'];
    } else if (cat.includes('natural stone') || cat.includes('marble') || cat.includes('granite')
      || cat.includes('travertine') || cat.includes('limestone') || cat.includes('slate')) {
      sections = ['colornames', 'porcelainceramic'];
    } else {
      sections = ['porcelainceramic', 'colornames', 'hardscaping', 'mosaics', 'lvt'];
    }

    // Generate slug candidates
    const slugCandidates = new Set();
    const fullSlug = words.join('-');
    const reversed = [...words].reverse().join('-');

    // Forward: "adella-gris"
    slugCandidates.add(fullSlug);
    // Reversed: "gris-adella" (common for porcelain)
    if (words.length >= 2) slugCandidates.add(reversed);
    // With -porcelain and -ceramic suffixes
    slugCandidates.add(fullSlug + '-porcelain');
    slugCandidates.add(fullSlug + '-ceramic');
    if (words.length >= 2) {
      slugCandidates.add(reversed + '-porcelain');
      slugCandidates.add(reversed + '-ceramic');
    }
    // First word only (collection name)
    if (words.length >= 2) {
      slugCandidates.add(words[0]);
      // Last word + first word (color-series)
      slugCandidates.add(words[words.length - 1] + '-' + words[0]);
    }

    let found = false;
    outer: for (const section of sections) {
      for (const slug of slugCandidates) {
        // Try root (high-res)
        const rootUrl = `https://cdn.msisurfaces.com/images/${section}/${slug}.jpg`;
        probed++;
        try {
          const resp = await fetch(rootUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (resp.ok) {
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, 'primary', $2, $2, 0)
              ON CONFLICT DO NOTHING
            `, [p.id, rootUrl]);
            matched++;
            found = true;
            if (matched % 25 === 0) console.log(`  Progress: ${matched} matched, ${probed} probed`);
            break outer;
          }
        } catch {}

        // Try thumbnails (fallback)
        const thumbUrl = `https://cdn.msisurfaces.com/images/${section}/thumbnails/${slug}.jpg`;
        probed++;
        try {
          const resp = await fetch(thumbUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (resp.ok) {
            // Found thumbnail, try to get high-res from root
            const hrUrl = `https://cdn.msisurfaces.com/images/${section}/${slug}.jpg`;
            let useUrl = thumbUrl;
            try {
              const hrResp = await fetch(hrUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0' } });
              if (hrResp.ok) useUrl = hrUrl;
            } catch {}
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, 'primary', $2, $2, 0)
              ON CONFLICT DO NOTHING
            `, [p.id, useUrl]);
            matched++;
            found = true;
            if (matched % 25 === 0) console.log(`  Progress: ${matched} matched, ${probed} probed`);
            break outer;
          }
        } catch {}

        await delay(30); // rate limit
      }
    }
  }

  log('CDN probes attempted:', probed);
  log('Products matched:', matched);
  return matched;
}

// ─── Phase 9: Same-collection sibling copy ──────────────────────────────

async function phase9(client, vid) {
  console.log('\n=== Phase 9: Same-collection sibling copy ===');

  // Find products with real collections that have siblings with images
  const { rows: missing } = await client.query(`
    SELECT p.id, p.display_name, p.collection, c.name AS category
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
      AND p.collection IS NOT NULL AND p.collection <> '' AND p.collection <> 'M S International Inc.'
    ORDER BY p.collection, p.display_name
  `, [vid]);

  console.log(`  Products with real collections needing images: ${missing.length}`);

  let copied = 0;
  for (const m of missing) {
    // Find a sibling in same collection with images
    const { rows: donors } = await client.query(`
      SELECT p2.id
      FROM products p2
      WHERE p2.vendor_id = $1 AND p2.status = 'active'
        AND p2.collection = $2 AND p2.id <> $3
        AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p2.id)
      LIMIT 1
    `, [vid, m.collection, m.id]);

    if (donors.length === 0) continue;

    const { rows: images } = await client.query(`
      SELECT url, original_url, asset_type, sort_order
      FROM media_assets
      WHERE product_id = $1
        AND url NOT LIKE '%roomvo%' AND url NOT LIKE '%miscellaneous%'
        AND url NOT LIKE '%prop65%' AND url NOT LIKE '%svg%'
      ORDER BY sort_order
      LIMIT 3
    `, [donors[0].id]);

    if (images.length === 0) continue;

    for (const img of images) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [m.id, img.asset_type, img.url, img.original_url || img.url, img.sort_order]);
    }
    copied++;
  }

  log('Products with images from collection siblings:', copied);
  return copied;
}

// ─── Phase 10: Deactivate non-products + zero-SKU products ──────────────

async function phase10(client, vid) {
  console.log('\n=== Phase 10: Deactivate non-products ===');

  // Architectural Binders — mounting kits, not decorative panels
  const { rowCount: binders } = await client.query(`
    UPDATE products SET status = 'inactive', is_active = false
    WHERE vendor_id = $1 AND status = 'active'
      AND (display_name LIKE 'Architectural Binder%' OR display_name LIKE 'Arch Binder%')
  `, [vid]);
  log('Architectural Binders deactivated:', binders);

  // Products with 0 active SKUs
  const { rowCount: noSkus } = await client.query(`
    UPDATE products SET status = 'inactive', is_active = false
    WHERE vendor_id = $1 AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active')
  `, [vid]);
  log('Zero-SKU products deactivated:', noSkus);

  // Raw EDI junk names — names that are just sizes/codes with no product name
  const { rowCount: junkNames } = await client.query(`
    UPDATE products SET status = 'inactive', is_active = false
    WHERE vendor_id = $1 AND status = 'active'
      AND (
        display_name ~ '^\\(?(Prem|Std)\\)?\\d'
        OR display_name ~ '^\\d+["x]'
        OR display_name ~ '^[A-Z]{2,4}\\d{3,}'
      )
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = products.id)
  `, [vid]);
  log('Junk-name products deactivated:', junkNames);

  // Artificial turf — not flooring
  const { rowCount: turf } = await client.query(`
    UPDATE products SET status = 'inactive', is_active = false
    WHERE vendor_id = $1 AND status = 'active'
      AND (display_name LIKE '%Emerald Turf%' OR display_name LIKE '%Putting Green%'
           OR display_name LIKE '%Pet Turf%' OR display_name LIKE '%Precut%Turf%')
  `, [vid]);
  log('Artificial turf products deactivated:', turf);

  return binders + noSkus + junkNames + turf;
}

// ─── Phase 11: Puppeteer-based scraping for remaining products ────────

async function phase11(db, vid) {
  console.log('\n=== Phase 11: Puppeteer scraping of MSI product pages ===');

  const puppeteer = require('puppeteer');

  // Step 1: Get all missing products with their SKU codes
  const { rows: missing } = await db.query(`
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

  console.log(`  Products still missing images: ${missing.length}`);
  if (missing.length === 0) return 0;

  // Step 2: Build a SKU lookup map from ALL MSI SKUs (for matching scraped pages)
  const { rows: allSkus } = await db.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.internal_sku
    FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vid]);
  const skuByInternal = new Map();
  const skuByVendor = new Map();
  for (const s of allSkus) {
    if (s.internal_sku) skuByInternal.set(s.internal_sku.toUpperCase(), s);
    if (s.vendor_sku) skuByVendor.set(s.vendor_sku.toUpperCase(), s);
  }

  // Build set of product IDs that need images
  const needsImage = new Set(missing.map(m => m.id));

  // Step 2b: Pre-match T&M products via VTT→VTR SKU conversion
  // VTT = Vinyl Tile Trim, VTR = Vinyl Tile Regular (floor)
  // e.g., VTTARCHBRM-EC → try to find VTR product with same color slug
  let tmPreMatch = 0;
  const trimSuffixes = ['-EC', '-FSN', '-FSN-EE', '-OSN', '-QR', '-SR', '-TL', '-T-SR', '-ST-EE'];
  for (const m of missing) {
    if (m.category !== 'Transitions & Moldings' || !m.vendor_skus) continue;

    for (const sku of m.vendor_skus) {
      const upper = sku.toUpperCase();
      if (!upper.startsWith('VTT')) continue;

      // Strip VTT prefix and trim suffix to get the color slug
      let colorSlug = upper.replace(/^VTT/, '');
      for (const sfx of trimSuffixes.sort((a, b) => b.length - a.length)) {
        if (colorSlug.endsWith(sfx)) {
          colorSlug = colorSlug.slice(0, -sfx.length);
          break;
        }
      }
      // Also strip dimension suffixes like "-94" or "-72"
      colorSlug = colorSlug.replace(/-\d{2,3}$/, '');

      if (!colorSlug || colorSlug.length < 4) continue;

      // Try to find matching VTR product (floor version)
      const vtrKey = 'MSI-VTR' + colorSlug;
      // Also try partial match — the VTR code may have dimension suffixes
      let donorProductId = null;
      for (const [key, val] of skuByInternal) {
        if (key.startsWith(vtrKey) && !needsImage.has(val.product_id)) {
          // Verify this product has images
          const { rows: [check] } = await db.query(
            `SELECT 1 FROM media_assets WHERE product_id = $1 LIMIT 1`,
            [val.product_id]
          );
          if (check) {
            donorProductId = val.product_id;
            break;
          }
        }
      }

      if (donorProductId) {
        const { rows: imgs } = await db.query(`
          SELECT url, original_url, asset_type, sort_order
          FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3
        `, [donorProductId]);

        for (const img of imgs) {
          try {
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, $2, $3, $4, $5)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [m.id, img.asset_type, img.url, img.original_url, img.sort_order]);
          } catch {}
        }
        if (imgs.length > 0) {
          tmPreMatch++;
          needsImage.delete(m.id);
        }
        break; // Move to next product
      }
    }
  }
  console.log(`  VTT→VTR pre-match: ${tmPreMatch} T&M products got images from floor siblings`);

  // Step 3: Fetch MSI sitemap for product URLs
  const https = require('https');
  function fetchUrl(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location).then(resolve, reject);
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  let sitemapUrls = [];
  try {
    const sitemap = await fetchUrl('https://www.msisurfaces.com/sitemap.xml');
    const urlMatches = sitemap.match(/<loc>([^<]+)<\/loc>/g) || [];
    sitemapUrls = urlMatches.map(m => m.replace(/<\/?loc>/g, ''))
      .filter(u => {
        const path = new URL(u).pathname;
        const segs = path.split('/').filter(Boolean);
        return segs.length >= 2 && !path.includes('/blog/') && !path.includes('/corporate/');
      });
    console.log(`  Sitemap: ${sitemapUrls.length} product URLs`);
  } catch (e) {
    console.log(`  Sitemap fetch failed: ${e.message}`);
  }

  // Step 4: Build candidate URL list — prioritize likely matches
  // Build a name-based index: normalized display_name → product_id
  function normalizeName(name) {
    return (name || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  const nameToProducts = new Map();
  for (const m of missing) {
    const norm = normalizeName(m.display_name);
    const words = norm.split(' ').filter(w => w.length > 2);
    if (words.length >= 1) {
      nameToProducts.set(norm, m);
    }
  }

  // Match sitemap URLs to missing products by checking if URL slug contains product name words
  const priorityUrls = [];
  const otherUrls = [];

  for (const url of sitemapUrls) {
    const path = new URL(url).pathname.toLowerCase();
    const slug = path.split('/').filter(Boolean).slice(1).join('-'); // skip category prefix

    let matched = false;
    for (const [norm, prod] of nameToProducts) {
      const words = norm.split(' ').filter(w => w.length > 2);
      // Check if most product name words appear in the URL slug
      const hits = words.filter(w => slug.includes(w));
      if (hits.length >= Math.max(1, words.length * 0.6)) {
        priorityUrls.push({ url, productId: prod.id, displayName: prod.display_name });
        matched = true;
        break;
      }
    }
    if (!matched) {
      otherUrls.push(url);
    }
  }

  console.log(`  Priority URLs (name-matched): ${priorityUrls.length}`);
  console.log(`  Other sitemap URLs: ${otherUrls.length}`);

  // Step 5: Launch Puppeteer and scrape (use local Chrome)
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let totalMatched = 0;
  let totalImages = 0;
  let totalVisited = 0;

  // Helper: extract images and SKU codes from a product page
  async function scrapePage(pageUrl) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Block fonts and media for speed
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['font', 'media'].includes(type)) req.abort();
      else req.continue();
    });

    try {
      // Load page with retry for rate limiting
      let retries = 0;
      while (retries < 3) {
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
        if (/too many requests|429|rate limit/i.test(bodyText)) {
          retries++;
          await delay(5000 * retries);
          continue;
        }
        break;
      }

      await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});

      // Expand accordions
      await page.evaluate(() => {
        document.querySelectorAll('.accordion-header, .accordion-toggle-icon, [data-toggle="collapse"], button[aria-expanded="false"]')
          .forEach(t => { try { t.click(); } catch(e) {} });
        document.querySelectorAll('.collapse').forEach(el => {
          el.classList.add('in', 'show');
          el.style.display = '';
          el.style.height = 'auto';
        });
        document.querySelectorAll('.tab-pane').forEach(el => {
          el.classList.add('active', 'in', 'show');
          el.style.display = '';
        });
      });
      await delay(600);

      // Extract SKU codes and images
      const data = await page.evaluate(() => {
        const result = { skus: [], images: [], name: '' };

        // Product name
        const h1 = document.querySelector('h1');
        if (h1) result.name = h1.textContent.trim();

        // SKU codes from "ID#: CODE" pattern
        const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
        const seen = new Set();
        for (const line of lines) {
          const m = line.match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            result.skus.push(m[1]);
          }
        }

        // Images — og:image, JSON-LD, and CDN img tags
        const imgSet = new Set();

        // og:image
        const og = document.querySelector('meta[property="og:image"]');
        if (og) {
          const src = og.getAttribute('content');
          if (src && src.includes('cdn.msisurfaces.com')) imgSet.add(src);
        }

        // JSON-LD
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const d = JSON.parse(script.textContent);
            const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
            for (const u of imgs) {
              if (u && u.includes('cdn.msisurfaces.com')) imgSet.add(u);
            }
            if (d['@graph']) {
              for (const item of d['@graph']) {
                if (item.image) {
                  const ii = Array.isArray(item.image) ? item.image : [item.image];
                  for (const u of ii) {
                    if (u && u.includes('cdn.msisurfaces.com')) imgSet.add(u);
                  }
                }
              }
            }
          } catch {}
        }

        // Gallery images
        document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
          const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy');
          if (src && !(/icon|logo|badge|placeholder|thumbnails|flyers|brochures|miscellaneous|roomvo/i.test(src))) {
            imgSet.add(src);
          }
        });

        result.images = [...imgSet].slice(0, 8);
        return result;
      });

      return data;
    } catch (err) {
      return null;
    } finally {
      await page.close();
    }
  }

  // Helper: save images for a product
  async function saveImages(productId, imageUrls) {
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

  // --- Scrape priority URLs first (name-matched from sitemap) ---
  console.log('\n  --- Scraping priority URLs (name-matched) ---');
  for (const { url, productId, displayName } of priorityUrls) {
    if (!needsImage.has(productId)) continue; // already found

    totalVisited++;
    const data = await scrapePage(url);
    if (!data || data.images.length === 0) {
      await delay(1500);
      continue;
    }

    // Match by SKU code first
    let matchedProductId = null;
    for (const code of data.skus) {
      const clean = code.replace(/\s+/g, '-').toUpperCase();
      const match = skuByInternal.get('MSI-' + clean) || skuByVendor.get(clean);
      if (match && needsImage.has(match.product_id)) {
        matchedProductId = match.product_id;
        break;
      }
    }

    // Fallback: use the pre-matched product ID from name matching
    if (!matchedProductId && needsImage.has(productId)) {
      matchedProductId = productId;
    }

    if (matchedProductId) {
      const imgCount = await saveImages(matchedProductId, data.images);
      if (imgCount > 0) {
        totalMatched++;
        totalImages += imgCount;
        needsImage.delete(matchedProductId);
      }
    }

    if (totalMatched % 25 === 0 && totalMatched > 0) {
      console.log(`  Progress: ${totalMatched} matched, ${totalVisited} visited, ${needsImage.size} remaining`);
    }

    await delay(2000);
  }

  console.log(`  Priority scrape: ${totalMatched} matched, ${totalImages} images from ${totalVisited} pages`);

  // --- Scrape remaining sitemap URLs (looking for any matching SKUs) ---
  if (needsImage.size > 0) {
    console.log(`\n  --- Scraping remaining sitemap URLs (${needsImage.size} products still need images) ---`);
    let otherMatched = 0;
    let otherVisited = 0;

    // Build category filters: only visit categories that have missing products
    const missingCats = new Set();
    for (const m of missing) {
      if (needsImage.has(m.id)) missingCats.add((m.category || '').toLowerCase());
    }

    const catPathMap = {
      'porcelain tile': ['/porcelain-tile/', '/large-format-tile/', '/wood-look-tile'],
      'mosaic tile': ['/mosaics/', '/backsplash-tile/'],
      'hardscaping': ['/hardscape/'],
      'stacked stone': ['/stacked-stone/', '/hardscape/rockmount-stacked-stone/'],
      'natural stone': ['/marble-tile/', '/travertine-tile/', '/granite-tile/', '/quartzite-tile/', '/slate-tile/', '/sandstone-tile/', '/limestone-tile/', '/onyx-tile/'],
      'lvp (plank)': ['/luxury-vinyl-flooring/', '/waterproof-wood-flooring/', '/waterproof-hybrid-rigid-core/'],
      'transitions & moldings': ['/luxury-vinyl-flooring/', '/waterproof-wood-flooring/'],
      'backsplash & wall tile': ['/backsplash-tile/'],
      'pavers': ['/hardscape/arterra-porcelain-pavers/', '/hardscape/pavers/'],
    };

    const relevantPaths = new Set();
    for (const cat of missingCats) {
      const paths = catPathMap[cat] || [];
      for (const p of paths) relevantPaths.add(p);
    }

    // Filter other URLs to only relevant categories
    const filteredUrls = relevantPaths.size > 0
      ? otherUrls.filter(u => {
          const path = new URL(u).pathname;
          return [...relevantPaths].some(rp => path.startsWith(rp));
        })
      : otherUrls;

    console.log(`  Filtered to ${filteredUrls.length} URLs in relevant categories`);

    for (const url of filteredUrls) {
      if (needsImage.size === 0) break;

      otherVisited++;
      const data = await scrapePage(url);
      if (!data || data.skus.length === 0 || data.images.length === 0) {
        await delay(1500);
        continue;
      }

      // Match by SKU code
      for (const code of data.skus) {
        const clean = code.replace(/\s+/g, '-').toUpperCase();
        const match = skuByInternal.get('MSI-' + clean) || skuByVendor.get(clean);
        if (match && needsImage.has(match.product_id)) {
          const imgCount = await saveImages(match.product_id, data.images);
          if (imgCount > 0) {
            totalMatched++;
            otherMatched++;
            totalImages += imgCount;
            needsImage.delete(match.product_id);
          }
        }
      }

      if (otherVisited % 100 === 0) {
        console.log(`  Progress: ${otherVisited}/${filteredUrls.length} visited, ${otherMatched} new matches, ${needsImage.size} remaining`);
      }

      await delay(2000);
    }

    console.log(`  Sitemap scrape: ${otherMatched} additional matches from ${otherVisited} pages`);
  }

  // --- Phase 11b: For remaining T&M and hardscaping, copy from named siblings ---
  if (needsImage.size > 0) {
    console.log(`\n  --- Phase 11b: Additional name-based matching for ${needsImage.size} remaining ---`);
    let sibling11 = 0;

    // For T&M: strip trim type suffix and try to find a product with matching base name
    const remainingMissing = missing.filter(m => needsImage.has(m.id));
    for (const m of remainingMissing) {
      if (m.category !== 'Transitions & Moldings') continue;

      // "Arch Brooks Maple Ec 94" → "Arch Brooks Maple"
      const baseName = m.display_name
        .replace(/\s+(Ec|Fsn|Osn|Qr|Sr|T|Tl)\s+\d+["']?\s*$/i, '')
        .trim();

      if (!baseName || baseName === m.display_name) continue;

      // Find any product with this base name (in any category) that HAS images
      const { rows: donors } = await db.query(`
        SELECT p.id FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND (p.display_name ILIKE $2 OR p.display_name ILIKE $3)
          AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
        LIMIT 1
      `, [vid, baseName + '%', baseName.replace(/\s+Oak$/i, '') + '%']);

      if (donors.length > 0) {
        const { rows: imgs } = await db.query(`
          SELECT url, original_url, asset_type, sort_order
          FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3
        `, [donors[0].id]);

        for (const img of imgs) {
          try {
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, $2, $3, $4, $5)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [m.id, img.asset_type, img.url, img.original_url, img.sort_order]);
          } catch {}
        }
        if (imgs.length > 0) {
          sibling11++;
          needsImage.delete(m.id);
        }
      }
    }

    // For hardscaping: group by base material name and copy from siblings
    for (const m of remainingMissing) {
      if (!needsImage.has(m.id)) continue;
      if (m.category !== 'Hardscaping' && m.category !== 'Stacked Stone' && m.category !== 'Natural Stone') continue;

      // Extract base name: "Diana Royal Copx3cm Sandblasted" → "Diana Royal"
      const baseName = m.display_name
        .replace(/\s*(Cop|Pav|Tread|Stepping|Cobble|Pebble|Coping|Pool|Kits|Pattern|Shotblast|Sandblast|Tumbl|Honed|Unfil|Eased|Mini|Grande).*$/i, '')
        .replace(/x\d+.*$/i, '')
        .replace(/\s+\d+["']?.*$/i, '')
        .trim();

      if (!baseName || baseName.length < 4) continue;

      const { rows: donors } = await db.query(`
        SELECT p.id FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND p.display_name ILIKE $2
          AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
        LIMIT 1
      `, [vid, baseName + '%']);

      if (donors.length > 0) {
        const { rows: imgs } = await db.query(`
          SELECT url, original_url, asset_type, sort_order
          FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3
        `, [donors[0].id]);

        for (const img of imgs) {
          try {
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, NULL, $2, $3, $4, $5)
              ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [m.id, img.asset_type, img.url, img.original_url, img.sort_order]);
          } catch {}
        }
        if (imgs.length > 0) {
          sibling11++;
          needsImage.delete(m.id);
        }
      }
    }

    console.log(`  Sibling name matching: ${sibling11} products filled`);
    totalMatched += sibling11;
  }

  await browser.close();

  log('Phase 11 total matched:', totalMatched);
  log('Phase 11 total images:', totalImages);
  log('Products still missing:', needsImage.size);

  return totalMatched;
}


// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`MSI Image Coverage ${DRY_RUN ? '[DRY RUN]' : '[EXECUTING]'}`);
  console.log('='.repeat(60));

  // Get vendor ID
  const { rows: [vendor] } = await pool.query(`SELECT id FROM vendors WHERE code = 'MSI'`);
  if (!vendor) throw new Error('MSI vendor not found');
  const vid = vendor.id;

  const shouldRun = (phase) => !PHASE_ONLY || PHASE_ONLY === phase;
  let r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0, r6 = 0, r8 = 0, r9 = 0, r10 = 0, r11 = 0;

  // ── Phases 1, 2, 4, 5, 9, 10: run in a transaction (fast SQL-only operations) ──
  if (shouldRun(1) || shouldRun(2) || shouldRun(4) || shouldRun(5) || shouldRun(9) || shouldRun(10)) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (shouldRun(1)) r1 = await phase1(client, vid);
      if (shouldRun(2)) r2 = await phase2(client, vid);
      if (shouldRun(4)) r4 = await phase4(client, vid);
      if (shouldRun(5)) r5 = await phase5(client, vid);
      if (shouldRun(9)) r9 = await phase9(client, vid);
      if (shouldRun(10)) r10 = await phase10(client, vid);

      if (DRY_RUN) {
        await client.query('ROLLBACK');
        console.log('\n[DRY RUN] Rolled back.');
      } else {
        await client.query('COMMIT');
        console.log('\n✓ Committed.');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('\n✗ Error:', err.message);
      console.error(err.stack);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  // ── Phase 3: web scraping (autocommit, slow) ──
  if (shouldRun(3) && !DRY_RUN) {
    r3 = await phase3(pool, vid);
  } else if (shouldRun(3) && DRY_RUN) {
    console.log('\n=== Phase 3: Skipped in dry-run ===');
  }

  // ── Phase 6: listing page scrape + CDN (autocommit, network calls) ──
  if (shouldRun(6) && !DRY_RUN) {
    r6 = await phase6(pool, vid);
  } else if (shouldRun(6) && DRY_RUN) {
    console.log('\n=== Phase 6: Skipped in dry-run ===');
  }

  // ── Phase 8: CDN slug harvesting (autocommit, network calls) ──
  if (shouldRun(8) && !DRY_RUN) {
    r8 = await phase8(pool, vid);
  } else if (shouldRun(8) && DRY_RUN) {
    console.log('\n=== Phase 8: Skipped in dry-run ===');
  }

  // ── Phase 11: Puppeteer scraping (autocommit, slow) ──
  if (shouldRun(11) && !DRY_RUN) {
    r11 = await phase11(pool, vid);
  } else if (shouldRun(11) && DRY_RUN) {
    console.log('\n=== Phase 11: Skipped in dry-run ===');
  }

  // ── Phase 7: report (always runs unless specific phase requested) ──
  if (!PHASE_ONLY || shouldRun(7)) {
    await phase7(pool, vid);
  }

  console.log('\n=== Summary ===');
  log('Phase 1 (lifestyle primary fix):', r1);
  log('Phase 2 (T&M image copy):', r2);
  log('Phase 3 (website scrape):', r3);
  log('Phase 4 (junk cleanup):', r4);
  log('Phase 5 (name-based copy):', r5);
  log('Phase 6 (listing page CDN):', r6);
  log('Phase 8 (CDN slug harvest):', r8);
  log('Phase 9 (collection sibling copy):', r9);
  log('Phase 10 (deactivate non-products):', r10);
  log('Phase 11 (Puppeteer scrape):', r11);

  await pool.end();
}

main();
