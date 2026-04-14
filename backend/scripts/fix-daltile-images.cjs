#!/usr/bin/env node
/**
 * fix-daltile-images.cjs — Rebuild Daltile product images from Coveo API
 *
 * Problem: Room scenes (_RES_, _COM_) stored as primaries, same image shared
 * across 50+ products, videos (.mp4) as images, tiny thumbnails (1KB).
 *
 * Matching strategies (in priority order):
 *   1. Direct SKU match — vendor_sku in DB matches Coveo sku field
 *   2. Color code match — extract color code from vendor_sku, match Coveo colorcode
 *   3. Collection+color name — match by collection + color attribute value
 *   4. Collection only — fallback to any image from same series
 *   5. Scene7 URL probe — construct URLs from color codes, HEAD-test them
 *
 * Each product gets at most ONE primary (product swatch) and ONE lifestyle
 * (room scene). No URL is shared across products.
 *
 * Usage:
 *   node backend/scripts/fix-daltile-images.cjs --dry-run   # Preview
 *   node backend/scripts/fix-daltile-images.cjs              # Execute
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Coveo API Configuration ────────────────────────────────────────────────

const COVEO_DOMAIN = 'www.daltile.com';
const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;

const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'colorcode', 'finish',
  'productimageurl', 'primaryroomsceneurl', 'producttype',
];

const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Floor Tile Deco',
  'Wall Tile', 'Wall Tile Trim', 'Wall Tile Deco',
  'Wall Bathroom Accessories',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim',
  'LVT Trim', 'LVT Plank', 'Luxury Vinyl Tile',
  'Porcelain Slab', 'Quartz Slab', 'Natural Stone Slab',
  'Quarry Tile', 'Quarry Tile Trim',
  'Windowsills-Thresholds',
];

// ─── Coveo API Functions ────────────────────────────────────────────────────

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${COVEO_DOMAIN}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${COVEO_DOMAIN}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Coveo API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function paginateQuery(extraFilter, totalCount) {
  const results = [];
  let offset = 0;
  while (offset < totalCount && offset < COVEO_OFFSET_LIMIT) {
    const pageSize = Math.min(PAGE_SIZE, totalCount - offset);
    const resp = await queryCoveo(extraFilter, offset, pageSize);
    const batch = resp.results || [];
    if (batch.length === 0) break;
    results.push(...batch);
    offset += batch.length;
    if (offset < totalCount) await delay(200);
  }
  return results;
}

async function fetchAllCoveoResults() {
  const probe = await queryCoveo('', 0, 0);
  const totalCount = probe.totalCount || 0;
  console.log(`  Coveo reports ${totalCount} total products`);
  if (totalCount === 0) return [];
  if (totalCount <= COVEO_OFFSET_LIMIT) return paginateQuery('', totalCount);

  console.log(`  Splitting by product type (${totalCount} > ${COVEO_OFFSET_LIMIT})`);
  const allResults = [];
  const seenSkus = new Set();

  for (const productType of PRODUCT_TYPE_SPLITS) {
    const typeFilter = ` @producttype=="${productType}"`;
    const typeProbe = await queryCoveo(typeFilter, 0, 0);
    const typeCount = typeProbe.totalCount || 0;
    if (typeCount === 0) continue;
    const results = await paginateQuery(typeFilter, typeCount);
    let added = 0;
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const key = rawSku.split(/[;,]/).map(s => s.trim().toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) { seenSkus.add(key); allResults.push(r); added++; }
    }
    if (added > 0) console.log(`    ${productType}: ${added}`);
  }

  // Catch-all
  const catchAllFilter = PRODUCT_TYPE_SPLITS.map(t => ` @producttype<>"${t}"`).join('');
  const catchProbe = await queryCoveo(catchAllFilter, 0, 0);
  if ((catchProbe.totalCount || 0) > 0) {
    const results = await paginateQuery(catchAllFilter, Math.min(catchProbe.totalCount, COVEO_OFFSET_LIMIT));
    let added = 0;
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const key = rawSku.split(/[;,]/).map(s => s.trim().toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) { seenSkus.add(key); allResults.push(r); added++; }
    }
    if (added > 0) console.log(`    (other): ${added}`);
  }

  return allResults;
}

// ─── Image Helpers ──────────────────────────────────────────────────────────

function upgradeImageUrl(url) {
  if (!url) return '';
  let u = url.trim();
  if (u.startsWith('http://')) u = u.replace('http://', 'https://');
  if (u.includes('scene7.com')) u = u.replace(/\?\$TRIMTHUMBNAIL\$/, '');
  return u;
}

function isRoomScene(url) {
  if (!url) return false;
  const u = url.toUpperCase();
  return u.includes('_RES_') || u.includes('_COM_') ||
    u.includes('ROOMSCENE') || u.includes('_ROOM') ||
    u.includes('_SCENE') || u.includes('LIFESTYLE');
}

function isUnusable(url) {
  if (!url) return true;
  const l = url.toLowerCase();
  return l.includes('.mp4') || l.includes('.webm') ||
    l.includes('placeholder') || l.includes('no-series-image') ||
    l.includes('no.series') || l.includes('coming-soon');
}

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Extract color code prefix from a Daltile vendor SKU.
 * Pattern: first 2-4 alphanumeric chars that look like a color code.
 * Daltile color codes: 2 letters + 2 digits (e.g., AC11, SK35, VL64)
 * or 4 digits (e.g., 0748) or letter+digits (e.g., P006)
 */
function extractColorCode(vendorSku) {
  if (!vendorSku) return null;
  const sku = vendorSku.toUpperCase().trim();
  // Standard: 2 letters + 2 digits (AC11, SK35, SO47)
  const m1 = sku.match(/^([A-Z]{2}\d{2})/);
  if (m1) return m1[1];
  // 4-digit prefix (0748)
  const m2 = sku.match(/^(\d{4})/);
  if (m2) return m2[1];
  // Letter + 3 digits (P006)
  const m3 = sku.match(/^([A-Z]\d{3})/);
  if (m3) return m3[1];
  // 1-2 letters + 2-3 digits (broader)
  const m4 = sku.match(/^([A-Z]{1,2}\d{2,3})/);
  if (m4) return m4[1];
  return null;
}

/**
 * Extract usable primary and lifestyle URLs from a Coveo result.
 */
function extractUrls(result) {
  const productImageUrl = getField(result, 'productimageurl');
  const roomSceneUrl = getField(result, 'primaryroomsceneurl');

  let primaryUrl = '';
  if (productImageUrl && !isUnusable(productImageUrl) && !isRoomScene(productImageUrl)) {
    primaryUrl = upgradeImageUrl(productImageUrl);
  }

  let lifestyleUrl = '';
  if (roomSceneUrl && !isUnusable(roomSceneUrl)) {
    lifestyleUrl = upgradeImageUrl(roomSceneUrl);
  }
  if (!lifestyleUrl && productImageUrl && !isUnusable(productImageUrl) && isRoomScene(productImageUrl)) {
    lifestyleUrl = upgradeImageUrl(productImageUrl);
  }

  return { primaryUrl, lifestyleUrl };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(DRY_RUN ? '--- DRY RUN MODE ---\n' : '--- LIVE MODE ---\n');

  // Step 1: Find Daltile vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1");
  if (vendorRes.rows.length === 0) { console.log('No Daltile vendor found.'); return; }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // Step 2: Load products and SKUs
  console.log('Loading products and SKUs...');
  const skuRes = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vendorId]);

  const skuMap = new Map();           // UPPER(vendor_sku) → { sku_id, product_id }
  const productColorCodes = new Map(); // product_id → Set<colorcode>
  for (const row of skuRes.rows) {
    if (!row.vendor_sku) continue;
    const upper = row.vendor_sku.toUpperCase();
    skuMap.set(upper, row);
    const cc = extractColorCode(upper);
    if (cc) {
      if (!productColorCodes.has(row.product_id)) productColorCodes.set(row.product_id, new Set());
      productColorCodes.get(row.product_id).add(cc);
    }
  }

  const productRes = await pool.query(`
    SELECT id, name, collection FROM products
    WHERE vendor_id = $1 AND status = 'active' ORDER BY collection, name
  `, [vendorId]);
  const products = productRes.rows;
  console.log(`  ${products.length} products, ${skuMap.size} SKUs\n`);

  // Load color attributes
  const colorAttrRes = await pool.query(`
    SELECT s.product_id, array_agg(DISTINCT sa.value) FILTER (WHERE sa.value IS NOT NULL) as colors
    FROM skus s
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'color'
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    GROUP BY s.product_id
  `, [vendorId]);
  const colorsByProduct = new Map();
  for (const row of colorAttrRes.rows) colorsByProduct.set(row.product_id, row.colors || []);

  const existingCount = await pool.query(
    `SELECT COUNT(*) as cnt FROM media_assets ma JOIN products p ON p.id = ma.product_id WHERE p.vendor_id = $1`,
    [vendorId]
  );
  console.log(`Existing media_assets: ${existingCount.rows[0].cnt}`);

  // Step 3: Fetch Coveo data
  console.log('\nFetching Coveo data...');
  const coveoResults = await fetchAllCoveoResults();
  console.log(`  Fetched ${coveoResults.length} Coveo results\n`);

  // Step 4: Build multiple Coveo indexes
  console.log('Building indexes...');

  // Index 1: by exact SKU → array of { primaryUrl, lifestyleUrl }
  const bySku = new Map();
  // Index 2: by color code → array of { primaryUrl, lifestyleUrl }
  const byColorCode = new Map();
  // Index 3: by series+color name → array of { primaryUrl, lifestyleUrl }
  const bySeriesColor = new Map();
  // Index 4: by series name → array of { primaryUrl, lifestyleUrl }
  const bySeries = new Map();

  for (const result of coveoResults) {
    const rawSku = getField(result, 'sku');
    const series = getField(result, 'seriesname');
    const color = getField(result, 'colornameenglish');
    const colorCode = getField(result, 'colorcode');
    const urls = extractUrls(result);
    if (!urls.primaryUrl && !urls.lifestyleUrl) continue;

    // Index by exact SKU
    if (rawSku) {
      const skuList = rawSku.split(/[;,]/).map(s => s.trim().toUpperCase()).filter(Boolean);
      for (const sku of skuList) {
        if (!bySku.has(sku)) bySku.set(sku, []);
        bySku.get(sku).push(urls);
      }
    }

    // Index by color code
    if (colorCode) {
      const cc = colorCode.toUpperCase().trim();
      if (!byColorCode.has(cc)) byColorCode.set(cc, []);
      byColorCode.get(cc).push(urls);
    }

    // Index by series+color
    if (series && color) {
      const key = norm(`${series} ${color}`);
      if (!bySeriesColor.has(key)) bySeriesColor.set(key, []);
      bySeriesColor.get(key).push(urls);

      // Without finish suffix
      const colorBase = color.replace(/\s+(matte|glossy|polished|textured|honed|tumbled|lappato|structured|satin polished|light polished|superguard\s*x?\s*technology|enhanced urethane)$/i, '').trim();
      if (colorBase !== color) {
        const altKey = norm(`${series} ${colorBase}`);
        if (!bySeriesColor.has(altKey)) bySeriesColor.set(altKey, []);
        bySeriesColor.get(altKey).push(urls);
      }
    }

    // Index by series
    if (series) {
      const key = norm(series);
      if (!bySeries.has(key)) bySeries.set(key, []);
      bySeries.get(key).push(urls);
    }
  }

  console.log(`  bySku: ${bySku.size} keys, byColorCode: ${byColorCode.size}, bySeriesColor: ${bySeriesColor.size}, bySeries: ${bySeries.size}\n`);

  // Step 5: Assign images to products — pick UNUSED URLs from candidate pools
  const assignedUrls = new Set();
  const assignments = []; // { product_id, primaryUrl, lifestyleUrl }

  const stats = { skuMatch: 0, colorCodeMatch: 0, nameMatch: 0, seriesMatch: 0, noMatch: 0 };

  /**
   * From a list of url-pairs, find one whose primaryUrl hasn't been assigned yet.
   * Returns { primaryUrl, lifestyleUrl } or null.
   */
  function pickUnused(candidates) {
    if (!candidates) return null;
    // First pass: prefer entries with unique primary
    for (const c of candidates) {
      if (c.primaryUrl && !assignedUrls.has(c.primaryUrl)) return c;
    }
    // Second pass: accept entries with only lifestyle
    for (const c of candidates) {
      if (c.lifestyleUrl && !assignedUrls.has(c.lifestyleUrl)) return { primaryUrl: '', lifestyleUrl: c.lifestyleUrl };
    }
    return null;
  }

  for (const product of products) {
    const skus = [];
    // Collect all vendor_sku for this product
    for (const [sku, row] of skuMap) {
      if (row.product_id === product.id) skus.push(sku);
    }

    let pick = null;
    let matchType = '';

    // Strategy 1: Direct SKU match
    for (const sku of skus) {
      pick = pickUnused(bySku.get(sku));
      if (pick) { matchType = 'sku'; break; }
    }

    // Strategy 2: Color code match
    if (!pick) {
      const codes = productColorCodes.get(product.id);
      if (codes) {
        for (const cc of codes) {
          pick = pickUnused(byColorCode.get(cc));
          if (pick) { matchType = 'colorCode'; break; }
        }
      }
    }

    // Strategy 3: Collection + color attribute name
    if (!pick) {
      const colors = colorsByProduct.get(product.id) || [];
      if (product.collection && colors.length > 0) {
        for (const color of colors) {
          pick = pickUnused(bySeriesColor.get(norm(`${product.collection} ${color}`)));
          if (pick) { matchType = 'name'; break; }
          const colorBase = color.replace(/\s+(matte|glossy|polished|textured|honed|tumbled|lappato|structured|satin|semi-textured)$/i, '').trim();
          if (colorBase !== color) {
            pick = pickUnused(bySeriesColor.get(norm(`${product.collection} ${colorBase}`)));
            if (pick) { matchType = 'name'; break; }
          }
        }
      }
    }

    // Strategy 4: Collection + product name
    if (!pick && product.collection) {
      pick = pickUnused(bySeriesColor.get(norm(`${product.collection} ${product.name}`)));
      if (pick) matchType = 'name';
    }

    // Strategy 5: Bare collection / series fallback
    if (!pick && product.collection) {
      pick = pickUnused(bySeries.get(norm(product.collection)));
      if (pick) matchType = 'series';
    }

    if (pick) {
      let primary = pick.primaryUrl || '';
      let lifestyle = pick.lifestyleUrl || '';

      if (primary && assignedUrls.has(primary)) primary = '';
      if (lifestyle && assignedUrls.has(lifestyle)) lifestyle = '';

      if (primary) assignedUrls.add(primary);
      if (lifestyle) assignedUrls.add(lifestyle);

      if (primary || lifestyle) {
        assignments.push({ product_id: product.id, primaryUrl: primary, lifestyleUrl: lifestyle });
        stats[matchType === 'sku' ? 'skuMatch' : matchType === 'colorCode' ? 'colorCodeMatch' : matchType === 'name' ? 'nameMatch' : 'seriesMatch']++;
      } else {
        stats.noMatch++;
      }
    } else {
      stats.noMatch++;
    }
  }

  const withPrimary = assignments.filter(a => a.primaryUrl).length;
  const withLifestyle = assignments.filter(a => a.lifestyleUrl).length;
  const withBoth = assignments.filter(a => a.primaryUrl && a.lifestyleUrl).length;

  console.log('Match results:');
  console.log(`  SKU match:        ${stats.skuMatch}`);
  console.log(`  Color code match: ${stats.colorCodeMatch}`);
  console.log(`  Name match:       ${stats.nameMatch}`);
  console.log(`  Series fallback:  ${stats.seriesMatch}`);
  console.log(`  No match:         ${stats.noMatch}`);
  console.log();
  console.log(`  Products with primary:   ${withPrimary}`);
  console.log(`  Products with lifestyle: ${withLifestyle}`);
  console.log(`  Products with both:      ${withBoth}`);
  console.log();

  // Step 6: Scene7 URL probing for products still without primary
  const productsWithoutPrimary = products.filter(p => !assignments.find(a => a.product_id === p.id && a.primaryUrl));
  const productsToProbe = [];

  for (const p of productsWithoutPrimary) {
    const codes = productColorCodes.get(p.id);
    if (codes && codes.size > 0) {
      productsToProbe.push({ product: p, colorCodes: [...codes] });
    }
  }

  if (productsToProbe.length > 0) {
    console.log(`Scene7 URL probing for ${productsToProbe.length} products without primary...`);
    let probeHits = 0, probeTested = 0;

    // Batch test Scene7 URLs — try {colorcode} as the image name on Scene7
    // Daltile Scene7 naming: various patterns, test a few per color code
    const SCENE7_BASE = 'https://s7d9.scene7.com/is/image/daltile/';

    for (const { product, colorCodes } of productsToProbe) {
      let found = false;
      for (const cc of colorCodes) {
        if (found) break;
        // Try patterns like: DAL_{cc}_ (the most common pattern in Coveo results)
        // We'll try a HEAD request against a broad Scene7 search
        const testUrls = [
          `${SCENE7_BASE}${cc}`,
          `${SCENE7_BASE}DAL_${cc}`,
        ];

        for (const testUrl of testUrls) {
          if (assignedUrls.has(testUrl)) continue;
          probeTested++;
          try {
            const resp = await fetch(testUrl, {
              method: 'HEAD',
              signal: AbortSignal.timeout(3000),
              redirect: 'follow',
            });
            const ct = resp.headers.get('content-type') || '';
            if (resp.status === 200 && ct.includes('image')) {
              // Found a valid image
              assignedUrls.add(testUrl);
              const existing = assignments.find(a => a.product_id === product.id);
              if (existing) {
                existing.primaryUrl = testUrl;
              } else {
                assignments.push({ product_id: product.id, primaryUrl: testUrl, lifestyleUrl: '' });
              }
              probeHits++;
              found = true;
              break;
            }
          } catch { /* timeout or network error — skip */ }
        }
      }

      // Rate limit Scene7 probing
      if (probeTested % 50 === 0 && probeTested > 0) await delay(500);
    }

    console.log(`  Tested ${probeTested} URLs, found ${probeHits} new images\n`);
  }

  // Recount
  const finalWithPrimary = assignments.filter(a => a.primaryUrl).length;
  const finalWithLifestyle = assignments.filter(a => a.lifestyleUrl).length;
  const finalWithAny = assignments.length;

  console.log('Final assignment counts:');
  console.log(`  With primary:   ${finalWithPrimary}`);
  console.log(`  With lifestyle: ${finalWithLifestyle}`);
  console.log(`  With any image: ${finalWithAny}`);
  console.log(`  No image:       ${products.length - finalWithAny}\n`);

  // Samples
  console.log('Sample assignments:');
  for (const a of assignments.filter(a => a.primaryUrl).slice(0, 6)) {
    const p = products.find(pr => pr.id === a.product_id);
    console.log(`  ${p ? p.collection + ' / ' + p.name : a.product_id}`);
    if (a.primaryUrl) console.log(`    PRI: ${a.primaryUrl.slice(0, 100)}`);
    if (a.lifestyleUrl) console.log(`    LIF: ${a.lifestyleUrl.slice(0, 100)}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would delete ${existingCount.rows[0].cnt} existing and insert ${finalWithPrimary + finalWithLifestyle} new images.`);
    await pool.end();
    return;
  }

  // Step 7: Delete all existing Daltile media_assets
  console.log('Deleting existing Daltile media_assets...');
  const deleteRes = await pool.query(
    `DELETE FROM media_assets WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)`,
    [vendorId]
  );
  console.log(`  Deleted ${deleteRes.rowCount} rows\n`);

  // Step 8: Insert new images
  console.log('Inserting new images...');
  let iPri = 0, iLif = 0;
  for (const a of assignments) {
    if (a.primaryUrl) {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $2, 0)
        ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET url = EXCLUDED.url
      `, [a.product_id, a.primaryUrl]);
      iPri++;
    }
    if (a.lifestyleUrl) {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'lifestyle', $2, $2, 0)
        ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET url = EXCLUDED.url
      `, [a.product_id, a.lifestyleUrl]);
      iLif++;
    }
  }
  console.log(`  Inserted ${iPri} primary + ${iLif} lifestyle\n`);

  // Step 9: Refresh search vectors
  console.log('Refreshing search vectors...');
  await pool.query("SELECT refresh_search_vectors()");

  // Step 10: Final report
  const finalCount = await pool.query(`
    SELECT asset_type, COUNT(*) as cnt, COUNT(DISTINCT product_id) as products
    FROM media_assets ma JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 GROUP BY asset_type ORDER BY asset_type
  `, [vendorId]);

  const dupeCheck = await pool.query(`
    SELECT COUNT(*) as cnt FROM (
      SELECT url FROM media_assets ma JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 GROUP BY url HAVING COUNT(DISTINCT product_id) > 1
    ) x
  `, [vendorId]);

  const noImages = await pool.query(`
    SELECT COUNT(*) as cnt FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
  `, [vendorId]);

  console.log('\n=== FINAL REPORT ===');
  console.log(`Total products: ${products.length}`);
  for (const row of finalCount.rows) {
    console.log(`  ${row.asset_type}: ${row.cnt} images across ${row.products} products`);
  }
  console.log(`  Shared URLs: ${dupeCheck.rows[0].cnt} (should be 0)`);
  console.log(`  No image: ${noImages.rows[0].cnt}`);
  console.log(`  Coverage: ${((products.length - parseInt(noImages.rows[0].cnt)) / products.length * 100).toFixed(1)}%\n`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
