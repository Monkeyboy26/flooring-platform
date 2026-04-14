#!/usr/bin/env node
/**
 * daltile-image-backfill.cjs
 *
 * Fills image gaps for Daltile products/SKUs that lost their images during cleanup.
 * Uses Coveo's productimageurl field (actual product photos) to backfill.
 *
 * Strategy:
 *   1. Re-fetch Coveo catalog
 *   2. Build (collection, color) → product image URL map
 *   3. For each active Daltile product lacking a primary image, look up its
 *      collection + color in the Coveo map and assign as product-level primary
 *   4. Since products are now grouped by (collection, color), each one gets
 *      one color-specific image (no sharing across colors)
 *
 * Usage:
 *   node backend/scripts/daltile-image-backfill.cjs --dry-run
 *   node backend/scripts/daltile-image-backfill.cjs
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
const COVEO_DOMAIN = 'www.daltile.com';
const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'primaryroomsceneurl', 'bodytype', 'producttype'];

const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Wall Tile', 'Wall Tile Trim',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim', 'LVT Trim', 'LVT Plank',
  'Luxury Vinyl Tile', 'Porcelain Slab', 'Quartz Slab',
  'Natural Stone Slab', 'Quarry Tile', 'Quarry Tile Trim',
  'Floor Tile Deco', 'Wall Tile Deco', 'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

const KNOWN_MATERIAL_SUFFIX_RE = /\s+Glass\s*$/i;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function stripKnownMaterialSuffix(c) { return c ? (c.replace(KNOWN_MATERIAL_SUFFIX_RE, '').trim() || c) : c; }

function stripMaterialSuffix(color, material) {
  if (!color || !material) return color;
  const matLower = material.trim().toLowerCase();
  const colorLower = color.trim().toLowerCase();
  if (colorLower.endsWith(' ' + matLower)) {
    const stripped = color.trim().slice(0, -(matLower.length + 1)).trim();
    return stripped || color;
  }
  const matWords = matLower.split(/\s+/);
  if (matWords.length > 1) {
    const lastWord = matWords[matWords.length - 1];
    if (colorLower.endsWith(' ' + lastWord)) {
      const stripped = color.trim().slice(0, -(lastWord.length + 1)).trim();
      return stripped || color;
    }
  }
  return color;
}

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') ||
    lower.includes('no.series') || lower.includes('coming-soon');
}

function stripPreset(url) {
  if (!url) return url;
  return url.replace(/\?\$[A-Z_]+\$/, '');
}

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${COVEO_DOMAIN}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${COVEO_DOMAIN}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
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
  if (totalCount === 0) return [];
  if (totalCount <= COVEO_OFFSET_LIMIT) return paginateQuery('', totalCount);
  const allResults = [];
  const seen = new Set();
  for (const pt of PRODUCT_TYPE_SPLITS) {
    const f = ` @producttype=="${pt}"`;
    const p = await queryCoveo(f, 0, 0);
    if (!p.totalCount) continue;
    const results = await paginateQuery(f, p.totalCount);
    for (const r of results) {
      const s = getField(r, 'sku');
      if (!s) continue;
      const key = s.split(/[;,]/).map(x => x.trim().toUpperCase()).sort().join('|');
      if (!seen.has(key)) { seen.add(key); allResults.push(r); }
    }
  }
  const catchFilter = PRODUCT_TYPE_SPLITS.map(t => `@producttype<>"${t}"`).join(' ');
  const cp = await queryCoveo(` ${catchFilter}`, 0, 0);
  if (cp.totalCount > 0) {
    const results = await paginateQuery(` ${catchFilter}`, Math.min(cp.totalCount, COVEO_OFFSET_LIMIT));
    for (const r of results) {
      const s = getField(r, 'sku');
      if (!s) continue;
      const key = s.split(/[;,]/).map(x => x.trim().toUpperCase()).sort().join('|');
      if (!seen.has(key)) { seen.add(key); allResults.push(r); }
    }
  }
  return allResults;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE IMAGE BACKFILL ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='DAL'");
  const vendorId = vendorRes.rows[0].id;

  // ── Step 1: Fetch Coveo ──
  console.log('─── Step 1: Fetching Coveo catalog ───\n');
  const results = await fetchAllCoveoResults();
  console.log(`  Total Coveo results: ${results.length}`);

  // ── Step 2: Build image map ──
  console.log('\n─── Step 2: Building image map ───\n');
  // Map: norm(series)|norm(color) → { productImage, roomScene }
  // Prefer entries that have a non-placeholder productimageurl
  const imageMap = new Map();

  for (const r of results) {
    const series = getField(r, 'seriesname');
    const rawColor = getField(r, 'colornameenglish');
    const material = getField(r, 'bodytype');
    const color = stripKnownMaterialSuffix(stripMaterialSuffix(rawColor, material));
    const prodImg = stripPreset(getField(r, 'productimageurl'));
    const roomImg = stripPreset(getField(r, 'primaryroomsceneurl'));

    if (!series || !color) continue;
    const validProd = prodImg && !isPlaceholderUrl(prodImg) ? prodImg : '';
    const validRoom = roomImg && !isPlaceholderUrl(roomImg) ? roomImg : '';
    if (!validProd && !validRoom) continue;

    const key = `${norm(series)}|${norm(color)}`;
    const existing = imageMap.get(key);
    // Prefer entries with a product image
    if (!existing) {
      imageMap.set(key, { productImage: validProd, roomScene: validRoom });
    } else {
      if (!existing.productImage && validProd) existing.productImage = validProd;
      if (!existing.roomScene && validRoom) existing.roomScene = validRoom;
    }
  }
  console.log(`  Image map entries: ${imageMap.size}`);
  const withProduct = [...imageMap.values()].filter(v => v.productImage).length;
  console.log(`  With product image: ${withProduct}`);

  // Also build a collection-level fallback: norm(series) → first valid product image
  const collectionImageMap = new Map();
  for (const r of results) {
    const series = getField(r, 'seriesname');
    const prodImg = stripPreset(getField(r, 'productimageurl'));
    if (!series || !prodImg || isPlaceholderUrl(prodImg)) continue;
    const key = norm(series);
    if (!collectionImageMap.has(key)) collectionImageMap.set(key, prodImg);
  }
  console.log(`  Collection-level fallback entries: ${collectionImageMap.size}\n`);

  // ── Step 3: Find products needing images ──
  console.log('─── Step 3: Finding products needing primary images ───\n');
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
           (SELECT sa.value FROM skus s JOIN sku_attributes sa ON sa.sku_id=s.id
              WHERE s.product_id=p.id AND s.status='active'
              AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
              LIMIT 1) as color
    FROM products p
    WHERE p.vendor_id=$1 AND p.status='active'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id=p.id AND ma.sku_id IS NULL AND ma.asset_type='primary'
      )
  `, [vendorId]);
  console.log(`  Products missing primary image: ${productsRes.rows.length}\n`);

  // ── Step 4: Match and assign ──
  console.log('─── Step 4: Matching and assigning images ───\n');
  let matched = 0, fallback = 0, unmatched = 0;
  const inserts = [];
  const unmatchedSamples = [];

  for (const p of productsRes.rows) {
    const collection = (p.collection || '').trim();
    const color = (p.color || '').trim();
    if (!collection) { unmatched++; continue; }

    let image = null;

    // Try collection + color match first
    if (color) {
      const key = `${norm(collection)}|${norm(color)}`;
      const entry = imageMap.get(key);
      if (entry && entry.productImage) {
        image = entry.productImage;
        matched++;
      }
    }

    // Fallback to collection-level image
    if (!image) {
      const collKey = norm(collection);
      const collImg = collectionImageMap.get(collKey);
      if (collImg) {
        image = collImg;
        fallback++;
      }
    }

    if (image) {
      inserts.push({ productId: p.id, url: image });
    } else {
      unmatched++;
      if (unmatchedSamples.length < 10) {
        unmatchedSamples.push(`${collection} | ${color} — ${p.name}`);
      }
    }
  }

  console.log(`  Matched (collection+color): ${matched}`);
  console.log(`  Fallback (collection only): ${fallback}`);
  console.log(`  Unmatched:                  ${unmatched}`);
  if (unmatchedSamples.length > 0) {
    console.log(`  Unmatched samples:`);
    for (const s of unmatchedSamples) console.log(`    ${s}`);
  }
  console.log(`  Total inserts queued: ${inserts.length}\n`);

  // ── Step 5: Execute inserts ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('─── Step 5: Inserting product-level primary images ───\n');
    let inserted = 0;
    for (const { productId, url } of inserts) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, url, asset_type)
        VALUES ($1, NULL, $2, 'primary')
        ON CONFLICT DO NOTHING
      `, [productId, url]);
      inserted++;
    }
    console.log(`  Inserted ${inserted} product-level primary images\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] Rolling back...\n');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Transaction committed.\n');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── Final summary ──
  console.log(`${'='.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Products needing images:   ${productsRes.rows.length}`);
  console.log(`  Matched by color:          ${matched}`);
  console.log(`  Matched by collection:     ${fallback}`);
  console.log(`  Still unmatched:           ${unmatched}`);
  console.log(`${'='.repeat(60)}\n`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
