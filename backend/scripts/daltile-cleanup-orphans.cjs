#!/usr/bin/env node
/**
 * daltile-cleanup-orphans.cjs
 *
 * Cleans up active Daltile SKUs that are stranded on inactive parent products.
 * These SKUs got left behind during previous runs of daltile-overhaul.cjs when
 * their parent product was deactivated (e.g., the old "Core Fundamentals ..."
 * products) but some of their sibling SKUs were moved into new collection+color
 * products.
 *
 * For each orphaned SKU:
 *   1. Look up its color attribute from DB (or Coveo if available)
 *   2. Find the matching active target product ({collection} {Color} or
 *      {collection} Trim & Accessories)
 *   3. Move the SKU (and its media) to that target product
 *   4. Refresh its size attribute from Coveo (fixing comma-joined values)
 *
 * Usage:
 *   node backend/scripts/daltile-cleanup-orphans.cjs --dry-run
 *   node backend/scripts/daltile-cleanup-orphans.cjs
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

const VENDOR_CODE = 'DAL';
const COVEO_DOMAIN = 'www.daltile.com';
const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;

const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'nominalsize',
  'finish', 'productshape', 'bodytype', 'producttype',
];

const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Wall Tile', 'Wall Tile Trim',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim', 'LVT Trim', 'LVT Plank',
  'Luxury Vinyl Tile', 'Porcelain Slab', 'Quartz Slab',
  'Natural Stone Slab', 'Quarry Tile', 'Quarry Tile Trim',
  'Floor Tile Deco', 'Wall Tile Deco', 'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

const ACCESSORY_NAME_RE = /\b(bullnose|bn\b|cv\s*b|cove\s*base|jolly|pencil\s*liner|chair\s*rail|shelf\s*rail|sink\s*rail|ogee|rope|liner|stair\s*nose|stp\s*ns|end\s*cap|vslcap|qrtr\s*round|vqrnd|4-in-1|slimt|coping|cop\b|accessor|v-?cap|mud\s*cap|trim|quarter\s*round|schluter|transition|molding)/i;

const GARBAGE_COLOR_RE = /^\d|^\d+[xX×]\d+|\b(cap|base|bullnose|jolly|trim|round|rounds|liner|cove|penny|hexagon|herringbone|chevron|diamond|lantern|arabesque|picket|basketweave|insert|end\s*cap|stair|mosaic|microban|grp\d|pts|dm|lvf|mm\b)/i;

const ACCESSORY_VARIANT_TYPES = new Set([
  'floor_trim', 'wall_trim', 'mosaic_trim', 'stone_trim',
  'quarry_trim', 'lvt_trim', 'bath_accessory', 'windowsills_thresholds',
  'accessory',
]);

const KNOWN_MATERIAL_SUFFIX_RE = /\s+Glass\s*$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function titleCase(s) {
  if (!s) return '';
  return s.replace(/\b\w+/g, w =>
    w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}
function isGarbageColor(value) {
  return GARBAGE_COLOR_RE.test((value || '').trim());
}
function stripKnownMaterialSuffix(color) {
  if (!color) return color;
  return color.replace(KNOWN_MATERIAL_SUFFIX_RE, '').trim() || color;
}
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
function sizeArea(size) {
  if (!size) return 0;
  const m = size.match(/([\d.\/]+)\s*[xX×]\s*([\d.\/]+)/);
  if (!m) return 0;
  const parse = s => {
    if (s.includes('/')) {
      const [a, b] = s.split('/').map(parseFloat);
      return b ? a / b : 0;
    }
    return parseFloat(s) || 0;
  };
  return parse(m[1]) * parse(m[2]);
}
function matchSizeToSku(vendorSku, sizes) {
  if (!sizes || sizes.length === 0) return '';
  if (sizes.length === 1) return sizes[0];
  const sku = (vendorSku || '').toUpperCase();
  let bestMatch = null, bestLen = 0;
  for (const size of sizes) {
    const digits = size.replace(/[^0-9]/g, '');
    if (digits.length >= 2 && sku.includes(digits) && digits.length > bestLen) {
      bestMatch = size;
      bestLen = digits.length;
    }
  }
  if (bestMatch) return bestMatch;
  let smallest = sizes[0], smallestArea = sizeArea(sizes[0]) || Infinity;
  for (const size of sizes) {
    const area = sizeArea(size);
    if (area > 0 && area < smallestArea) { smallest = size; smallestArea = area; }
  }
  return smallest;
}
function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') || lower.includes('no.series') || lower.includes('coming-soon');
}
function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}
function getFieldArray(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return [];
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
  const s = String(val).trim();
  return s ? [s] : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Coveo
// ─────────────────────────────────────────────────────────────────────────────

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
    throw new Error(`Coveo API error ${resp.status}: ${text.slice(0, 200)}`);
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

  const allResults = [];
  const seenSkus = new Set();
  for (const productType of PRODUCT_TYPE_SPLITS) {
    const typeFilter = ` @producttype=="${productType}"`;
    const typeProbe = await queryCoveo(typeFilter, 0, 0);
    const typeCount = typeProbe.totalCount || 0;
    if (typeCount === 0) continue;
    const results = await paginateQuery(typeFilter, typeCount);
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) { seenSkus.add(key); allResults.push(r); }
    }
  }
  const catchAllFilter = PRODUCT_TYPE_SPLITS.map(t => `@producttype<>"${t}"`).join(' ');
  const catchProbe = await queryCoveo(` ${catchAllFilter}`, 0, 0);
  if ((catchProbe.totalCount || 0) > 0) {
    const results = await paginateQuery(` ${catchAllFilter}`, Math.min(catchProbe.totalCount, COVEO_OFFSET_LIMIT));
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) { seenSkus.add(key); allResults.push(r); }
    }
  }
  return allResults;
}

function isAccessoryBySku(sku, coveoEntry) {
  if (sku.variant_type === 'accessory') return true;
  if (ACCESSORY_VARIANT_TYPES.has(sku.variant_type)) return true;
  if (sku.variant_name && ACCESSORY_NAME_RE.test(sku.variant_name)) return true;
  if (coveoEntry && coveoEntry.productType && /trim|accessor/i.test(coveoEntry.productType)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE ORPHAN CLEANUP ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = $1", [VENDOR_CODE]);
  if (vendorRes.rows.length === 0) { console.error('Vendor DAL not found'); process.exit(1); }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // ── Phase 1: Coveo Pre-Load ──
  console.log('─── Phase 1: Coveo Pre-Load ───\n');
  const allCoveoResults = await fetchAllCoveoResults();
  console.log(`  Total Coveo results: ${allCoveoResults.length}`);

  const coveoByVendorSku = new Map();
  for (const result of allCoveoResults) {
    const rawSku = getField(result, 'sku');
    const series = getField(result, 'seriesname');
    const color = getField(result, 'colornameenglish');
    const sizeArr = getFieldArray(result, 'nominalsize');
    const finish = getField(result, 'finish');
    const shape = getField(result, 'productshape');
    const material = getField(result, 'bodytype');
    const productType = getField(result, 'producttype');
    const cleanColor = stripMaterialSuffix(color, material);

    if (rawSku) {
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      for (const sku of skuParts) {
        const specificSize = matchSizeToSku(sku, sizeArr);
        const entry = { series, color: cleanColor, size: specificSize, finish, shape, material, productType };
        const key = sku.toUpperCase();
        if (!coveoByVendorSku.has(key)) coveoByVendorSku.set(key, entry);
      }
    }
  }
  console.log(`  coveoByVendorSku: ${coveoByVendorSku.size} entries\n`);

  // ── Phase 2: Load orphaned SKUs ──
  console.log('─── Phase 2: Loading Orphaned SKUs ───\n');
  const orphansRes = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type, s.sell_by,
           sa.value as color_value,
           p.collection, p.name as old_product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
    WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'inactive'
    ORDER BY s.vendor_sku
  `, [vendorId]);
  console.log(`  Found ${orphansRes.rows.length} orphaned SKUs on inactive products\n`);

  // Load attribute IDs
  const attrRes = await pool.query("SELECT id, slug FROM attributes WHERE slug IN ('color','size','finish','shape','material')");
  const attrIds = {};
  for (const row of attrRes.rows) attrIds[row.slug] = row.id;

  // ── Phase 3: For each orphan, find target product ──
  const stats = {
    moved_to_existing: 0,
    moved_to_new: 0,
    no_collection: 0,
    no_target_found: 0,
    size_updated: 0,
    color_updated: 0,
    media_reparented: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Transaction started.\n');
    console.log('─── Phase 3: Moving Orphaned SKUs ───\n');

    const affectedProductIds = new Set();

    for (const sku of orphansRes.rows) {
      try {
        const collection = (sku.collection || '').trim();
        if (!collection) { stats.no_collection++; continue; }

        const coveoEntry = coveoByVendorSku.get((sku.vendor_sku || '').toUpperCase());

        // Determine color
        let color = '';
        if (coveoEntry && coveoEntry.color) {
          color = coveoEntry.color;
        } else if (sku.color_value && !isGarbageColor(sku.color_value)) {
          color = stripKnownMaterialSuffix(sku.color_value);
        }

        // Determine target product name
        const isAccessory = isAccessoryBySku(sku, coveoEntry);
        let targetName;
        if (isAccessory) {
          targetName = `${collection} Trim & Accessories`;
        } else if (color) {
          targetName = `${collection} ${titleCase(color)}`;
        } else {
          targetName = collection;
        }

        // Look up the existing active target product
        const existing = await client.query(
          `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND status = 'active'`,
          [vendorId, collection, targetName]
        );

        let targetProductId;
        if (existing.rows.length > 0) {
          targetProductId = existing.rows[0].id;
          stats.moved_to_existing++;
        } else {
          // Create it
          const newProd = await client.query(`
            INSERT INTO products (vendor_id, name, collection, status)
            VALUES ($1, $2, $3, 'active')
            ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
            DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP
            RETURNING id
          `, [vendorId, targetName, collection]);
          targetProductId = newProd.rows[0].id;
          stats.moved_to_new++;
        }

        affectedProductIds.add(targetProductId);

        // Move the SKU
        await client.query(
          `UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [targetProductId, sku.id]
        );

        // Reparent SKU-level media
        const mediaMove = await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE sku_id = $2 RETURNING id`,
          [targetProductId, sku.id]
        );
        stats.media_reparented += mediaMove.rowCount;

        // Update color attribute if we have a clean one
        if (color && attrIds.color) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.color, color]);
          stats.color_updated++;
        }

        // Update size attribute from Coveo (single-size matched)
        if (coveoEntry && coveoEntry.size && attrIds.size) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.size, coveoEntry.size]);
          stats.size_updated++;
        }

        // Update finish/shape/material if Coveo has them
        if (coveoEntry) {
          for (const [field, slug] of [['finish','finish'],['shape','shape'],['material','material']]) {
            if (coveoEntry[field] && attrIds[slug]) {
              await client.query(`
                INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
                ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
              `, [sku.id, attrIds[slug], coveoEntry[field]]);
            }
          }
        }
      } catch (err) {
        console.error(`  Error moving "${sku.vendor_sku}": ${err.message}`);
        stats.errors++;
      }
    }

    console.log(`  Moved to existing products: ${stats.moved_to_existing}`);
    console.log(`  Moved to newly created products: ${stats.moved_to_new}`);
    console.log(`  Media assets reparented: ${stats.media_reparented}`);
    console.log(`  Color attributes updated: ${stats.color_updated}`);
    console.log(`  Size attributes updated: ${stats.size_updated}`);
    console.log(`  Errors: ${stats.errors}\n`);

    // ── Phase 4: Refresh search vectors on affected products ──
    console.log('─── Phase 4: Refreshing Search Vectors ───\n');
    let searchRefreshed = 0;
    for (const pid of affectedProductIds) {
      try {
        await client.query('SELECT refresh_search_vectors($1)', [pid]);
        searchRefreshed++;
      } catch (_err) { /* ignore */ }
    }
    console.log(`  Refreshed search vectors for ${searchRefreshed} products\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] Rolling back transaction...\n');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Transaction committed.\n');
    }

    console.log(`${'='.repeat(60)}`);
    console.log('  SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`  Orphaned SKUs:           ${orphansRes.rows.length}`);
    console.log(`  Moved to existing:       ${stats.moved_to_existing}`);
    console.log(`  Moved to new:            ${stats.moved_to_new}`);
    console.log(`  Size attrs updated:      ${stats.size_updated}`);
    console.log(`  Color attrs updated:     ${stats.color_updated}`);
    console.log(`  Media reparented:        ${stats.media_reparented}`);
    console.log(`  Errors:                  ${stats.errors}`);
    console.log(`${'='.repeat(60)}\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
