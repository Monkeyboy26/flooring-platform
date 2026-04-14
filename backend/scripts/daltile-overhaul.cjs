#!/usr/bin/env node
/**
 * daltile-overhaul.cjs
 *
 * Complete Daltile data overhaul: fixes product grouping, naming, attributes,
 * images, and categories in a single transaction with 7 phases.
 *
 * Current state:  ~2,315 products, ~10,193 SKUs, 0 SKU-level images,
 *                 garbage color attributes, accessories mixed with field tiles.
 *
 * Target state:   ~1,300-1,500 clean products (one per collection+color),
 *                 proper accessory separation, SKU-level images from Coveo,
 *                 clean display names.
 *
 * Usage:
 *   node backend/scripts/daltile-overhaul.cjs --dry-run
 *   node backend/scripts/daltile-overhaul.cjs
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VENDOR_CODE = 'DAL';
const COVEO_DOMAIN = 'www.daltile.com';
const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;

const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'nominalsize',
  'finish', 'productshape', 'bodytype', 'countryofmanufacture',
  'shadevariation', 'specialfeatures', 'productimageurl',
  'primaryroomsceneurl', 'pdpurl', 'sampleavailable',
  'producttype',
];

// Product types for splitting Coveo queries (same as daltile-catalog.js)
const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Wall Tile', 'Wall Tile Trim',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim', 'LVT Trim', 'LVT Plank',
  'Luxury Vinyl Tile', 'Porcelain Slab', 'Quartz Slab',
  'Natural Stone Slab', 'Quarry Tile', 'Quarry Tile Trim',
  'Floor Tile Deco', 'Wall Tile Deco', 'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

// Accessory keywords in product names / variant names / color attributes
const ACCESSORY_NAME_RE = /\b(bullnose|bn\b|cv\s*b|cove\s*base|jolly|pencil\s*liner|chair\s*rail|shelf\s*rail|sink\s*rail|ogee|rope|liner|stair\s*nose|stp\s*ns|end\s*cap|vslcap|qrtr\s*round|vqrnd|4-in-1|slimt|coping|cop\b|accessor|v-?cap|mud\s*cap|trim|quarter\s*round|schluter|transition|molding)/i;

// Garbage color patterns — these are not real colors
const GARBAGE_COLOR_RE = /^\d|^\d+[xX×]\d+|\b(cap|base|bullnose|jolly|trim|round|rounds|liner|cove|penny|hexagon|herringbone|chevron|diamond|lantern|arabesque|picket|basketweave|insert|end\s*cap|stair|mosaic|microban|grp\d|pts|dm|lvf|mm\b)/i;

// Coveo product type → variant_type mapping
const PRODUCT_TYPE_MAP = {
  'Floor Tile':              'floor_tile',
  'Floor Tile Trim':         'floor_trim',
  'Floor Tile Deco':         'floor_deco',
  'Wall Tile':               'wall_tile',
  'Wall Tile Trim':          'wall_trim',
  'Wall Tile Deco':          'wall_deco',
  'Wall Bathroom Accessories': 'bath_accessory',
  'Mosaic Tile':             'mosaic',
  'Mosaic Tile Trim':        'mosaic_trim',
  'Mosaic Natural Stone Tile': 'mosaic_stone',
  'Stone Tile':              'stone_tile',
  'Stone Tile Trim':         'stone_trim',
  'Quarry Tile':             'quarry_tile',
  'Quarry Tile Trim':        'quarry_trim',
  'Porcelain Slab':          'porcelain_slab',
  'Quartz Slab':             'quartz_slab',
  'Natural Stone Slab':      'natural_stone_slab',
  'Luxury Vinyl Tile':       'lvt',
  'LVT Trim':               'lvt_trim',
  'LVT Plank':               'lvt_plank',
  'Windowsills-Thresholds':  'windowsills_thresholds',
};

// variant_type → category slug
const VARIANT_TYPE_TO_CATEGORY = {
  floor_tile:      'porcelain-tile',
  floor_trim:      'porcelain-tile',
  floor_deco:      'porcelain-tile',
  wall_tile:       'backsplash-tile',
  wall_trim:       'backsplash-tile',
  wall_deco:       'backsplash-tile',
  bath_accessory:  'backsplash-tile',
  stone_tile:      'natural-stone',
  stone_trim:      'natural-stone',
  mosaic:          'mosaic-tile',
  mosaic_trim:     'mosaic-tile',
  mosaic_stone:    'mosaic-tile',
  lvt:             'lvp-plank',
  lvt_trim:        'lvp-plank',
  lvt_plank:       'lvp-plank',
  quarry_tile:     'ceramic-tile',
  quarry_trim:     'ceramic-tile',
  quartz_slab:     'quartz-countertops',
  porcelain_slab:  'porcelain-slabs',
  windowsills_thresholds: 'natural-stone',
};

// Accessory variant_types → these products are trim/accessories
const ACCESSORY_VARIANT_TYPES = new Set([
  'floor_trim', 'wall_trim', 'mosaic_trim', 'stone_trim',
  'quarry_trim', 'lvt_trim', 'bath_accessory', 'windowsills_thresholds',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Coveo API (reused from daltile-catalog.js)
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

  console.log(`  Splitting by product type (total > ${COVEO_OFFSET_LIMIT})`);
  const allResults = [];
  const seenSkus = new Set();

  for (const productType of PRODUCT_TYPE_SPLITS) {
    const typeFilter = ` @producttype=="${productType}"`;
    const typeProbe = await queryCoveo(typeFilter, 0, 0);
    const typeCount = typeProbe.totalCount || 0;
    if (typeCount === 0) continue;

    console.log(`    ${productType}: ${typeCount}`);
    const results = await paginateQuery(typeFilter, typeCount);
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) { seenSkus.add(key); allResults.push(r); }
    }
  }

  // Catch-all for unlisted types
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

/**
 * Parse a size string like "12X24", "1/2X12", "3X15" into square-inch area.
 */
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

/**
 * Match a vendor_sku to its specific size from a list of possible sizes.
 * Coveo's nominalsize often contains sizes for multiple SKUs in one entry.
 *   e.g. SKU "AS12RCT1224MT" with sizes ["12X24","30X60"] → "12X24"
 *
 * Strategy:
 *   1. Digit match — find the size whose digits appear in the SKU code (e.g., "1224" in "RCT1224")
 *   2. Fallback — pick the smallest size by area (mosaic sheets tend to share entries with floor tiles)
 */
function matchSizeToSku(vendorSku, sizes) {
  if (!sizes || sizes.length === 0) return '';
  if (sizes.length === 1) return sizes[0];
  const sku = (vendorSku || '').toUpperCase();

  // Pass 1: digit match, prefer longer (more specific) digit sequences
  let bestMatch = null, bestLen = 0;
  for (const size of sizes) {
    const digits = size.replace(/[^0-9]/g, '');
    if (digits.length >= 2 && sku.includes(digits) && digits.length > bestLen) {
      bestMatch = size;
      bestLen = digits.length;
    }
  }
  if (bestMatch) return bestMatch;

  // Pass 2: fallback — pick smallest size by area (mosaic/trim tends to be smaller)
  let smallest = sizes[0], smallestArea = sizeArea(sizes[0]) || Infinity;
  for (const size of sizes) {
    const area = sizeArea(size);
    if (area > 0 && area < smallestArea) {
      smallest = size;
      smallestArea = area;
    }
  }
  return smallest;
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') || lower.includes('no.series') || lower.includes('coming-soon');
}

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

// Known material words that Coveo appends to color names but shouldn't be part of the color
const KNOWN_MATERIAL_SUFFIX_RE = /\s+Glass\s*$/i;

function stripKnownMaterialSuffix(color) {
  if (!color) return color;
  return color.replace(KNOWN_MATERIAL_SUFFIX_RE, '').trim() || color;
}

function isAccessoryName(name) {
  return ACCESSORY_NAME_RE.test(name || '');
}

/**
 * Strip material suffix from Coveo color names.
 * Coveo sometimes appends the body type to the color (e.g., "Grey Glass", "Brook Crest Glass").
 * If the color ends with a word matching the material/bodytype, strip it.
 */
function stripMaterialSuffix(color, material) {
  if (!color || !material) return color;
  const matLower = material.trim().toLowerCase();
  const colorLower = color.trim().toLowerCase();
  // Check if color ends with the material word
  if (colorLower.endsWith(' ' + matLower)) {
    const stripped = color.trim().slice(0, -(matLower.length + 1)).trim();
    return stripped || color; // Don't return empty
  }
  // Also check last word of multi-word materials (e.g., "Natural Stone" → "Stone")
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

function isGarbageColor(value) {
  return GARBAGE_COLOR_RE.test((value || '').trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE DATA OVERHAUL ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Find vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = $1", [VENDOR_CODE]);
  if (vendorRes.rows.length === 0) { console.error('Vendor DAL not found'); process.exit(1); }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // ── Before metrics ──
  const beforeMetrics = await gatherMetrics(vendorId);
  console.log('=== BEFORE ===');
  printMetrics(beforeMetrics);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Coveo Pre-Load
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('─── Phase 1: Coveo Pre-Load ───\n');
  const allCoveoResults = await fetchAllCoveoResults();
  console.log(`  Total Coveo results: ${allCoveoResults.length}`);

  // Build lookup maps
  const coveoByVendorSku = new Map();   // UPPER(sku) → coveo entry
  const coveoBySeriesColor = new Map(); // norm("series color") → coveo entry

  for (const result of allCoveoResults) {
    const rawSku = getField(result, 'sku');
    const series = getField(result, 'seriesname');
    const color = getField(result, 'colornameenglish');
    const sizeArr = getFieldArray(result, 'nominalsize');
    const finish = getField(result, 'finish');
    const shape = getField(result, 'productshape');
    const material = getField(result, 'bodytype');
    const imageUrl = getField(result, 'productimageurl');
    const roomSceneUrl = getField(result, 'primaryroomsceneurl');
    const productType = getField(result, 'producttype');

    const validImg = imageUrl && !isPlaceholderUrl(imageUrl) ? imageUrl : '';
    const validRoom = roomSceneUrl && !isPlaceholderUrl(roomSceneUrl) ? roomSceneUrl : '';

    // Strip material suffix from color (e.g., "Grey Glass" → "Grey" when bodytype is "Glass")
    const cleanColor = stripMaterialSuffix(color, material);

    // Index by each SKU — each SKU gets its OWN entry with the specific size matched
    // (Coveo often groups multiple SKUs with parallel but alphabetically-sorted size arrays)
    if (rawSku) {
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      for (const sku of skuParts) {
        const specificSize = matchSizeToSku(sku, sizeArr);
        const entry = {
          series, color: cleanColor, size: specificSize,
          finish, shape, material,
          imageUrl: validImg, roomSceneUrl: validRoom, productType,
        };
        const key = sku.toUpperCase();
        if (!coveoByVendorSku.has(key)) coveoByVendorSku.set(key, entry);
      }
    }

    // A generic entry for series+color indexing (size is the first/primary size)
    const entry = {
      series, color: cleanColor, size: sizeArr[0] || '',
      finish, shape, material,
      imageUrl: validImg, roomSceneUrl: validRoom, productType,
    };

    // Index by series+color (use cleanColor so "Grey Glass" and "Grey" merge)
    if (series && cleanColor) {
      const scKey = norm(`${series} ${cleanColor}`);
      if (!coveoBySeriesColor.has(scKey)) coveoBySeriesColor.set(scKey, entry);
    }
  }

  console.log(`  coveoByVendorSku: ${coveoByVendorSku.size} entries`);
  console.log(`  coveoBySeriesColor: ${coveoBySeriesColor.size} entries\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Load all Daltile data from DB
  // ═══════════════════════════════════════════════════════════════════════════

  // Load all active Daltile products
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection, p.display_name, p.category_id, p.status
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.collection, p.name
  `, [vendorId]);
  const allProducts = productsRes.rows;

  // Load all active SKUs with color attributes
  const skusRes = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.internal_sku, s.variant_name,
           s.variant_type, s.sell_by, s.status,
           sa.value as color_value
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
    WHERE p.vendor_id = $1 AND p.status = 'active' AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  // Build product → SKUs map
  const skusByProduct = new Map();
  for (const s of skusRes.rows) {
    if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
    skusByProduct.get(s.product_id).push(s);
  }

  console.log(`  Loaded ${allProducts.length} active products, ${skusRes.rows.length} active SKUs\n`);

  // Load attribute IDs
  const attrRes = await pool.query("SELECT id, slug FROM attributes WHERE slug IN ('color','size','finish','shape','material')");
  const attrIds = {};
  for (const row of attrRes.rows) attrIds[row.slug] = row.id;

  // Load category map
  const catRes = await pool.query('SELECT id, slug FROM categories');
  const catMap = {};
  for (const row of catRes.rows) catMap[row.slug] = row.id;

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Product Regrouping
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('─── Phase 2: Product Regrouping ───\n');

  // Build the regrouping plan: for each SKU, determine which new product it belongs to
  // New product key: collection|||color for field tiles, collection|||ACCESSORIES for accessories

  const regroupPlan = new Map(); // newProductKey → { collection, color, isAccessory, skuIds: [], sourceProductIds: Set }
  const skuNewProduct = new Map(); // skuId → newProductKey

  for (const product of allProducts) {
    const skus = skusByProduct.get(product.id) || [];
    if (skus.length === 0) continue;

    const collection = (product.collection || '').trim();
    if (!collection) continue;

    for (const sku of skus) {
      // Determine color for this SKU
      let color = '';
      const coveoEntry = coveoByVendorSku.get((sku.vendor_sku || '').toUpperCase());

      if (coveoEntry && coveoEntry.color) {
        color = coveoEntry.color; // Already stripped in Phase 1
      } else if (sku.color_value && !isGarbageColor(sku.color_value)) {
        color = stripKnownMaterialSuffix(sku.color_value);
      }

      // Determine if this SKU is an accessory
      const isAccessory = isAccessoryBySku(sku, coveoEntry);

      let key;
      if (isAccessory) {
        key = `${collection}|||ACCESSORIES`;
      } else if (color) {
        key = `${collection}|||${norm(color)}`;
      } else {
        // No color — catchall
        key = `${collection}|||CATCHALL`;
      }

      skuNewProduct.set(sku.id, key);

      if (!regroupPlan.has(key)) {
        regroupPlan.set(key, {
          collection,
          color: isAccessory ? '' : color,
          isAccessory,
          isCatchall: !isAccessory && !color,
          skuIds: [],
          sourceProductIds: new Set(),
        });
      }

      const group = regroupPlan.get(key);
      group.skuIds.push(sku.id);
      group.sourceProductIds.add(product.id);
      // Use first non-empty color as canonical
      if (!group.isAccessory && !group.isCatchall && color && !group.color) {
        group.color = color;
      }
    }
  }

  console.log(`  Regrouping plan: ${regroupPlan.size} target products`);
  console.log(`    Field tile (color): ${[...regroupPlan.values()].filter(g => !g.isAccessory && !g.isCatchall).length}`);
  console.log(`    Accessory: ${[...regroupPlan.values()].filter(g => g.isAccessory).length}`);
  console.log(`    Catchall (no color): ${[...regroupPlan.values()].filter(g => g.isCatchall).length}`);

  // Count products that will change
  const productsWithMultipleTargets = new Set();
  const productTargets = new Map(); // productId → Set of target keys
  for (const [key, group] of regroupPlan) {
    for (const pid of group.sourceProductIds) {
      if (!productTargets.has(pid)) productTargets.set(pid, new Set());
      productTargets.get(pid).add(key);
    }
  }
  for (const [pid, targets] of productTargets) {
    if (targets.size > 1) productsWithMultipleTargets.add(pid);
  }
  console.log(`  Products being split: ${productsWithMultipleTargets.size}`);
  console.log(`  Products unchanged: ${allProducts.length - productsWithMultipleTargets.size}\n`);

  if (DRY_RUN) {
    // Show sample regrouping
    console.log('  --- Sample regrouping (first 30 targets) ---\n');
    let shown = 0;
    for (const [key, group] of regroupPlan) {
      if (shown >= 30) break;
      const label = group.isAccessory ? `${group.collection} Trim & Accessories`
        : group.isCatchall ? `${group.collection} (catchall)`
        : `${group.collection} ${group.color}`;
      console.log(`    "${label}" — ${group.skuIds.length} SKUs from ${group.sourceProductIds.size} source products`);
      shown++;
    }
    if (regroupPlan.size > 30) console.log(`    ... and ${regroupPlan.size - 30} more\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Execute all phases in a single transaction
  // ═══════════════════════════════════════════════════════════════════════════

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Simulating remaining phases...\n');

    // Count Coveo matches for attributes/images
    let coveoMatched = 0;
    for (const sku of skusRes.rows) {
      if (coveoByVendorSku.has((sku.vendor_sku || '').toUpperCase())) coveoMatched++;
    }
    console.log(`  Phase 4 (Attributes): ${coveoMatched}/${skusRes.rows.length} SKUs matched in Coveo`);
    console.log(`  Phase 5 (Images): up to ${coveoMatched} SKU-level images from Coveo`);
    console.log(`  Phase 6 (Categories): will fix accessory variant_type and categories`);
    console.log(`  Phase 7 (Search): will refresh search vectors for all affected products\n`);

    console.log('[DRY RUN] No database changes made. Remove --dry-run to execute.\n');
    await pool.end();
    return;
  }

  // ── LIVE EXECUTION ──

  const stats = {
    products_created: 0,
    products_reused: 0,
    skus_moved: 0,
    products_deactivated: 0,
    display_names_set: 0,
    variant_names_updated: 0,
    attrs_color: 0,
    attrs_size: 0,
    attrs_finish: 0,
    attrs_shape: 0,
    attrs_material: 0,
    attrs_garbage_deleted: 0,
    images_sku_primary: 0,
    images_sku_lifestyle: 0,
    images_product_fallback: 0,
    accessory_type_fixed: 0,
    categories_fixed: 0,
    search_vectors_refreshed: 0,
    media_reparented: 0,
    fk_updates: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Transaction started.\n');

    // Track all affected product IDs for search refresh
    const affectedProductIds = new Set();

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 2 EXECUTION: Create/reuse target products, move SKUs
    // ═════════════════════════════════════════════════════════════════════════

    console.log('─── Phase 2: Executing regrouping ───\n');

    // Map: regroupKey → target product ID
    const targetProductMap = new Map();

    for (const [key, group] of regroupPlan) {
      try {
        // Determine product name
        let productName;
        if (group.isAccessory) {
          productName = `${group.collection} Trim & Accessories`;
        } else if (group.isCatchall) {
          productName = group.collection;
        } else {
          productName = `${group.collection} ${titleCase(group.color)}`;
        }

        // Try to find an existing product with this (vendor_id, collection, name) combo
        const existing = await client.query(
          `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND status = 'active'`,
          [vendorId, group.collection, productName]
        );

        let targetProductId;
        if (existing.rows.length > 0) {
          targetProductId = existing.rows[0].id;
          stats.products_reused++;
        } else {
          // Create new product
          const newProd = await client.query(`
            INSERT INTO products (vendor_id, name, collection, status)
            VALUES ($1, $2, $3, 'active')
            ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
            DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP
            RETURNING id
          `, [vendorId, productName, group.collection]);
          targetProductId = newProd.rows[0].id;
          stats.products_created++;
        }

        targetProductMap.set(key, targetProductId);
        affectedProductIds.add(targetProductId);

        // Move SKUs to this target product
        for (const skuId of group.skuIds) {
          await client.query(
            `UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [targetProductId, skuId]
          );
          stats.skus_moved++;
        }

        // Re-parent SKU-level media assets
        if (group.skuIds.length > 0) {
          await client.query(
            `UPDATE media_assets SET product_id = $1 WHERE sku_id = ANY($2)`,
            [targetProductId, group.skuIds]
          );
        }
      } catch (err) {
        console.error(`  Error processing group "${key}": ${err.message}`);
        stats.errors++;
      }
    }

    console.log(`  Products created: ${stats.products_created}, reused: ${stats.products_reused}`);
    console.log(`  SKUs moved: ${stats.skus_moved}\n`);

    // ── Move FK references from source products to target products ──

    console.log('  Moving FK references...');

    // For each source product, find which target product its SKUs went to.
    // If all SKUs went to one target, reparent all FKs. If split, reparent to the largest target.
    const sourceToTarget = new Map(); // sourceProductId → targetProductId (for FK reparenting)
    for (const product of allProducts) {
      const skus = skusByProduct.get(product.id) || [];
      if (skus.length === 0) continue;

      // Find the primary target (where most SKUs went)
      const targetCounts = new Map();
      for (const sku of skus) {
        const key = skuNewProduct.get(sku.id);
        if (!key) continue;
        const tid = targetProductMap.get(key);
        if (!tid) continue;
        targetCounts.set(tid, (targetCounts.get(tid) || 0) + 1);
      }

      if (targetCounts.size === 0) continue;

      // Pick the target with most SKUs
      let bestTarget = null, bestCount = 0;
      for (const [tid, cnt] of targetCounts) {
        if (cnt > bestCount) { bestTarget = tid; bestCount = cnt; }
      }

      if (bestTarget && bestTarget !== product.id) {
        sourceToTarget.set(product.id, bestTarget);
      }
    }

    // Reparent FK references
    const FK_TABLES = [
      { table: 'cart_items', col: 'product_id' },
      { table: 'quote_items', col: 'product_id' },
      { table: 'sample_request_items', col: 'product_id' },
      { table: 'showroom_visit_items', col: 'product_id' },
      { table: 'trade_favorite_items', col: 'product_id' },
      { table: 'estimate_items', col: 'product_id' },
      { table: 'installation_inquiries', col: 'product_id' },
    ];

    for (const [sourceId, targetId] of sourceToTarget) {
      for (const fk of FK_TABLES) {
        try {
          const res = await client.query(
            `UPDATE ${fk.table} SET ${fk.col} = $1 WHERE ${fk.col} = $2`,
            [targetId, sourceId]
          );
          stats.fk_updates += res.rowCount;
        } catch { /* table may not have any rows — ok */ }
      }

      // product_tags — merge
      try {
        await client.query(`
          INSERT INTO product_tags (product_id, tag_id)
          SELECT $1, tag_id FROM product_tags WHERE product_id = $2
          ON CONFLICT (product_id, tag_id) DO NOTHING
        `, [targetId, sourceId]);
        await client.query(`DELETE FROM product_tags WHERE product_id = $1`, [sourceId]);
      } catch { }

      // wishlists — merge
      try {
        await client.query(`
          INSERT INTO wishlists (customer_id, product_id, created_at)
          SELECT customer_id, $1, created_at FROM wishlists WHERE product_id = $2
          ON CONFLICT (customer_id, product_id) DO NOTHING
        `, [targetId, sourceId]);
        await client.query(`DELETE FROM wishlists WHERE product_id = $1`, [sourceId]);
      } catch { }

      // product_reviews — merge
      try {
        await client.query(`
          INSERT INTO product_reviews (product_id, customer_id, rating, title, body, created_at)
          SELECT $1, customer_id, rating, title, body, created_at FROM product_reviews WHERE product_id = $2
          ON CONFLICT (product_id, customer_id) DO NOTHING
        `, [targetId, sourceId]);
        await client.query(`DELETE FROM product_reviews WHERE product_id = $1`, [sourceId]);
      } catch { }

      // Move remaining product-level media to target (avoid conflicts)
      try {
        // Delete source product-level media that conflicts with target
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = $2 AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $1 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [targetId, sourceId]);

        // Move remaining
        const maxSortRes = await client.query(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM media_assets WHERE product_id = $1 AND sku_id IS NULL`,
          [targetId]
        );
        let nextSort = parseInt(maxSortRes.rows[0].next_sort) || 0;
        const remaining = await client.query(
          `SELECT id FROM media_assets WHERE product_id = $1 AND sku_id IS NULL ORDER BY sort_order`,
          [sourceId]
        );
        for (const row of remaining.rows) {
          await client.query(
            `UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3`,
            [targetId, nextSort++, row.id]
          );
          stats.media_reparented++;
        }
      } catch { }
    }

    console.log(`  FK references moved: ${stats.fk_updates}`);
    console.log(`  Media reparented: ${stats.media_reparented}\n`);

    // ── Deactivate source products that now have 0 active SKUs ──

    console.log('  Deactivating empty source products...');

    for (const product of allProducts) {
      // Skip if this product IS a target product
      if ([...targetProductMap.values()].includes(product.id)) continue;

      const remaining = await client.query(
        `SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1 AND status = 'active'`,
        [product.id]
      );

      if (parseInt(remaining.rows[0].cnt) === 0) {
        // Check for order history
        const orderRefs = await client.query(
          `SELECT COUNT(*) FROM order_items WHERE product_id = $1`,
          [product.id]
        );
        const hasOrders = parseInt(orderRefs.rows[0].count) > 0;

        await client.query(`
          UPDATE products SET status = $2, is_active = false, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [product.id, hasOrders ? 'archived' : 'inactive']);
        stats.products_deactivated++;
      }
    }

    console.log(`  Products deactivated: ${stats.products_deactivated}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 3: Name Cleanup
    // ═════════════════════════════════════════════════════════════════════════

    console.log('─── Phase 3: Name Cleanup ───\n');

    for (const [key, group] of regroupPlan) {
      const targetId = targetProductMap.get(key);
      if (!targetId) continue;

      try {
        let displayName;
        if (group.isAccessory) {
          displayName = `${group.collection} Trim & Accessories`;
        } else {
          // Field tile: display_name = collection name
          // Frontend's fullProductName() appends Color + Size + Finish from attributes
          displayName = group.collection;
        }

        await client.query(
          `UPDATE products SET display_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [targetId, displayName]
        );
        stats.display_names_set++;

        // Update variant_names for SKUs in this group
        for (const skuId of group.skuIds) {
          // Find this SKU's data
          const skuData = skusRes.rows.find(s => s.id === skuId);
          if (!skuData) continue;

          const coveo = coveoByVendorSku.get((skuData.vendor_sku || '').toUpperCase());
          const color = coveo?.color || (skuData.color_value && !isGarbageColor(skuData.color_value) ? stripKnownMaterialSuffix(skuData.color_value) : '');

          if (color) {
            await client.query(
              `UPDATE skus SET variant_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [skuId, titleCase(color)]
            );
            stats.variant_names_updated++;
          }
        }
      } catch (err) {
        console.error(`  Error naming "${key}": ${err.message}`);
        stats.errors++;
      }
    }

    console.log(`  Display names set: ${stats.display_names_set}`);
    console.log(`  Variant names updated: ${stats.variant_names_updated}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 4: Attribute Repair
    // ═════════════════════════════════════════════════════════════════════════

    console.log('─── Phase 4: Attribute Repair ───\n');

    for (const sku of skusRes.rows) {
      const coveo = coveoByVendorSku.get((sku.vendor_sku || '').toUpperCase());

      if (coveo) {
        // Upsert attributes from Coveo
        if (coveo.color && attrIds.color) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.color, coveo.color]);
          stats.attrs_color++;
        }
        if (coveo.size && attrIds.size) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.size, coveo.size]);
          stats.attrs_size++;
        }
        if (coveo.finish && attrIds.finish) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.finish, coveo.finish]);
          stats.attrs_finish++;
        }
        if (coveo.shape && attrIds.shape) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.shape, coveo.shape]);
          stats.attrs_shape++;
        }
        if (coveo.material && attrIds.material) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrIds.material, coveo.material]);
          stats.attrs_material++;
        }
      } else {
        // No Coveo match — delete garbage color attributes OR strip material suffix
        if (sku.color_value && attrIds.color) {
          if (isGarbageColor(sku.color_value)) {
            await client.query(
              `DELETE FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2`,
              [sku.id, attrIds.color]
            );
            stats.attrs_garbage_deleted++;
          } else {
            // Strip material suffix from color (e.g., "Grey Glass" → "Grey")
            const stripped = stripKnownMaterialSuffix(sku.color_value);
            if (stripped !== sku.color_value) {
              await client.query(`
                INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
                ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
              `, [sku.id, attrIds.color, stripped]);
              stats.attrs_color++;
            }
          }
        }
      }
    }

    console.log(`  Color attrs set: ${stats.attrs_color}`);
    console.log(`  Size attrs set: ${stats.attrs_size}`);
    console.log(`  Finish attrs set: ${stats.attrs_finish}`);
    console.log(`  Shape attrs set: ${stats.attrs_shape}`);
    console.log(`  Material attrs set: ${stats.attrs_material}`);
    console.log(`  Garbage colors deleted: ${stats.attrs_garbage_deleted}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 5: Image Assignment
    // ═════════════════════════════════════════════════════════════════════════

    console.log('─── Phase 5: Image Assignment ───\n');

    // Tier 1: Direct vendor_sku match
    for (const sku of skusRes.rows) {
      const coveo = coveoByVendorSku.get((sku.vendor_sku || '').toUpperCase());
      if (!coveo) continue;

      const targetKey = skuNewProduct.get(sku.id);
      const targetProductId = targetKey ? targetProductMap.get(targetKey) : null;
      if (!targetProductId) continue;

      if (coveo.imageUrl) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'primary', $3, $3, 0)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [targetProductId, sku.id, coveo.imageUrl.startsWith('http://') ? coveo.imageUrl.replace('http://', 'https://') : coveo.imageUrl]);
        stats.images_sku_primary++;
      }
      if (coveo.roomSceneUrl) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'lifestyle', $3, $3, 0)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [targetProductId, sku.id, coveo.roomSceneUrl.startsWith('http://') ? coveo.roomSceneUrl.replace('http://', 'https://') : coveo.roomSceneUrl]);
        stats.images_sku_lifestyle++;
      }
    }

    // Tier 2: Series+color match for SKUs not matched in Tier 1
    for (const sku of skusRes.rows) {
      if (coveoByVendorSku.has((sku.vendor_sku || '').toUpperCase())) continue; // already matched

      const targetKey = skuNewProduct.get(sku.id);
      const targetProductId = targetKey ? targetProductMap.get(targetKey) : null;
      if (!targetProductId) continue;

      // Find product collection
      const product = allProducts.find(p => p.id === sku.product_id);
      if (!product) continue;

      const color = sku.color_value && !isGarbageColor(sku.color_value) ? sku.color_value : '';
      if (!color) continue;

      const scKey = norm(`${product.collection} ${color}`);
      const coveo = coveoBySeriesColor.get(scKey);
      if (!coveo) continue;

      if (coveo.imageUrl) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'primary', $3, $3, 0)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [targetProductId, sku.id, coveo.imageUrl.startsWith('http://') ? coveo.imageUrl.replace('http://', 'https://') : coveo.imageUrl]);
        stats.images_sku_primary++;
      }
      if (coveo.roomSceneUrl) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'lifestyle', $3, $3, 0)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [targetProductId, sku.id, coveo.roomSceneUrl.startsWith('http://') ? coveo.roomSceneUrl.replace('http://', 'https://') : coveo.roomSceneUrl]);
        stats.images_sku_lifestyle++;
      }
    }

    // Tier 3: Product fallback — for products still with 0 images, use any Coveo entry for same series
    const productsWithNoImages = await client.query(`
      SELECT p.id, p.collection FROM products p
      LEFT JOIN media_assets ma ON ma.product_id = p.id
      WHERE p.vendor_id = $1 AND p.status = 'active' AND ma.id IS NULL
    `, [vendorId]);

    for (const prod of productsWithNoImages.rows) {
      if (!prod.collection) continue;

      // Find any Coveo entry for this series
      let bestEntry = null;
      for (const [scKey, entry] of coveoBySeriesColor) {
        if (scKey.startsWith(norm(prod.collection) + ' ') && entry.imageUrl) {
          bestEntry = entry;
          break;
        }
      }

      if (bestEntry && bestEntry.imageUrl) {
        const imgUrl = bestEntry.imageUrl.startsWith('http://') ? bestEntry.imageUrl.replace('http://', 'https://') : bestEntry.imageUrl;
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, 'primary', $2, $2, 0)
          ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [prod.id, imgUrl]);
        stats.images_product_fallback++;
      }
    }

    console.log(`  SKU primary images: ${stats.images_sku_primary}`);
    console.log(`  SKU lifestyle images: ${stats.images_sku_lifestyle}`);
    console.log(`  Product fallback images: ${stats.images_product_fallback}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 6: Category & Variant Type Correction
    // ═════════════════════════════════════════════════════════════════════════

    console.log('─── Phase 6: Category & Variant Type Correction ───\n');

    // Ensure accessory SKUs have correct variant_type and sell_by
    for (const [key, group] of regroupPlan) {
      if (!group.isAccessory) continue;
      const targetId = targetProductMap.get(key);
      if (!targetId) continue;

      for (const skuId of group.skuIds) {
        const res = await client.query(`
          UPDATE skus SET variant_type = 'accessory', sell_by = 'unit', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND (variant_type IS DISTINCT FROM 'accessory' OR sell_by IS DISTINCT FROM 'unit')
        `, [skuId]);
        if (res.rowCount > 0) stats.accessory_type_fixed++;
      }
    }

    // Fix variant_type for non-accessory SKUs using Coveo productType
    // (Previous runs may have incorrectly set variant_type = 'accessory')
    let variantTypesReset = 0;
    for (const sku of skusRes.rows) {
      const coveo = coveoByVendorSku.get((sku.vendor_sku || '').toUpperCase());
      if (!coveo || !coveo.productType) continue;

      const coveoType = PRODUCT_TYPE_MAP[coveo.productType] || null;
      if (!coveoType) continue;

      // If this SKU is in a non-accessory group, set its variant_type from Coveo
      const targetKey = skuNewProduct.get(sku.id);
      const group = targetKey ? regroupPlan.get(targetKey) : null;
      if (group && !group.isAccessory) {
        const correctSellBy = ACCESSORY_VARIANT_TYPES.has(coveoType) ? 'unit' : (sku.sell_by || 'sqft');
        const correctType = ACCESSORY_VARIANT_TYPES.has(coveoType) ? 'accessory' : coveoType;
        await client.query(`
          UPDATE skus SET variant_type = $2, sell_by = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND (variant_type IS DISTINCT FROM $2 OR sell_by IS DISTINCT FROM $3)
        `, [sku.id, correctType, correctSellBy]);
        variantTypesReset++;
      }
    }

    console.log(`  Accessory SKUs fixed: ${stats.accessory_type_fixed}`);
    console.log(`  Variant types corrected from Coveo: ${variantTypesReset}`);

    // Fix categories on all active Daltile products
    const activeProds = await client.query(`
      SELECT p.id, p.collection FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
    `, [vendorId]);

    for (const prod of activeProds.rows) {
      // Get dominant variant_type (excluding accessories)
      const vtRes = await client.query(`
        SELECT variant_type, COUNT(*) as cnt
        FROM skus
        WHERE product_id = $1 AND status = 'active' AND variant_type IS NOT NULL AND variant_type != 'accessory'
        GROUP BY variant_type ORDER BY cnt DESC LIMIT 1
      `, [prod.id]);

      // Check if this is an accessory-only product
      const accCheck = await client.query(`
        SELECT COUNT(*) as total,
               COUNT(*) FILTER (WHERE variant_type = 'accessory') as acc
        FROM skus WHERE product_id = $1 AND status = 'active'
      `, [prod.id]);

      let targetCatSlug;
      const totalSkus = parseInt(accCheck.rows[0].total);
      const accSkus = parseInt(accCheck.rows[0].acc);

      if (totalSkus > 0 && accSkus === totalSkus) {
        // All accessories — use "transitions-moldings" if exists, else porcelain-tile
        targetCatSlug = catMap['transitions-moldings'] ? 'transitions-moldings' : 'porcelain-tile';
      } else if (vtRes.rows.length > 0) {
        const dominantType = vtRes.rows[0].variant_type;
        targetCatSlug = VARIANT_TYPE_TO_CATEGORY[dominantType] || 'porcelain-tile';
      } else {
        continue; // no active SKUs
      }

      const targetCatId = catMap[targetCatSlug];
      if (targetCatId) {
        const res = await client.query(
          `UPDATE products SET category_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND (category_id IS DISTINCT FROM $2)`,
          [prod.id, targetCatId]
        );
        if (res.rowCount > 0) stats.categories_fixed++;
      }
    }

    console.log(`  Categories fixed: ${stats.categories_fixed}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 7: Validation & Search Refresh
    // ═════════════════════════════════════════════════════════════════════════

    console.log('─── Phase 7: Validation & Search Refresh ───\n');

    // Refresh search vectors for all active Daltile products
    const allActiveProds = await client.query(
      `SELECT id FROM products WHERE vendor_id = $1 AND status = 'active'`,
      [vendorId]
    );

    for (const prod of allActiveProds.rows) {
      try {
        await client.query('SELECT refresh_search_vectors($1)', [prod.id]);
        stats.search_vectors_refreshed++;
      } catch { /* function may not exist — non-fatal */ }
    }

    console.log(`  Search vectors refreshed: ${stats.search_vectors_refreshed}`);

    // Flag remaining issues
    const emptyProducts = await client.query(`
      SELECT p.id, p.name, p.collection FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM skus WHERE product_id = p.id AND status = 'active')
    `, [vendorId]);

    if (emptyProducts.rows.length > 0) {
      console.log(`\n  WARNING: ${emptyProducts.rows.length} active products with 0 SKUs:`);
      for (const p of emptyProducts.rows.slice(0, 10)) {
        console.log(`    "${p.collection} — ${p.name}" (${p.id})`);
      }
      // Deactivate them
      for (const p of emptyProducts.rows) {
        await client.query(
          `UPDATE products SET status = 'inactive', is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [p.id]
        );
        stats.products_deactivated++;
      }
      console.log(`    Deactivated all ${emptyProducts.rows.length} empty products.`);
    }

    // ── COMMIT ──
    await client.query('COMMIT');
    console.log('\nTransaction committed successfully.\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nTransaction ROLLED BACK:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('=== RESULTS ===\n');
  console.log(`  Products created:         ${stats.products_created}`);
  console.log(`  Products reused:          ${stats.products_reused}`);
  console.log(`  Products deactivated:     ${stats.products_deactivated}`);
  console.log(`  SKUs moved:               ${stats.skus_moved}`);
  console.log(`  Display names set:        ${stats.display_names_set}`);
  console.log(`  Variant names updated:    ${stats.variant_names_updated}`);
  console.log(`  Attrs — color:            ${stats.attrs_color}`);
  console.log(`  Attrs — size:             ${stats.attrs_size}`);
  console.log(`  Attrs — finish:           ${stats.attrs_finish}`);
  console.log(`  Attrs — shape:            ${stats.attrs_shape}`);
  console.log(`  Attrs — material:         ${stats.attrs_material}`);
  console.log(`  Garbage colors deleted:   ${stats.attrs_garbage_deleted}`);
  console.log(`  SKU primary images:       ${stats.images_sku_primary}`);
  console.log(`  SKU lifestyle images:     ${stats.images_sku_lifestyle}`);
  console.log(`  Product fallback images:  ${stats.images_product_fallback}`);
  console.log(`  Accessory types fixed:    ${stats.accessory_type_fixed}`);
  console.log(`  Categories fixed:         ${stats.categories_fixed}`);
  console.log(`  Search vectors refreshed: ${stats.search_vectors_refreshed}`);
  console.log(`  FK references updated:    ${stats.fk_updates}`);
  console.log(`  Media reparented:         ${stats.media_reparented}`);
  if (stats.errors > 0) console.log(`  Errors:                   ${stats.errors}`);
  console.log('');

  // ── After metrics ──
  const afterMetrics = await gatherMetrics(vendorId);
  console.log('=== AFTER ===');
  printMetrics(afterMetrics);

  console.log('\n=== COMPARISON ===');
  console.log(`  Products:         ${beforeMetrics.products} → ${afterMetrics.products}`);
  console.log(`  SKUs:             ${beforeMetrics.skus} → ${afterMetrics.skus}`);
  console.log(`  Max SKUs/product: ${beforeMetrics.maxSkusPerProduct} → ${afterMetrics.maxSkusPerProduct}`);
  console.log(`  SKU-level images: ${beforeMetrics.skuImages} → ${afterMetrics.skuImages}`);
  console.log(`  Color coverage:   ${beforeMetrics.colorCoverage}% → ${afterMetrics.colorCoverage}%`);
  console.log('');

  await pool.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessory detection
// ─────────────────────────────────────────────────────────────────────────────

function isAccessoryBySku(sku, coveoEntry) {
  // Primary signal: Coveo productType is authoritative
  if (coveoEntry) {
    const coveoType = PRODUCT_TYPE_MAP[coveoEntry.productType] || '';
    if (ACCESSORY_VARIANT_TYPES.has(coveoType)) return true;
    // If Coveo says it's a field tile, trust it — NOT an accessory
    if (coveoType && !ACCESSORY_VARIANT_TYPES.has(coveoType)) return false;
  }

  // Secondary signal: DB variant_type from original EDI import
  if (sku.variant_type === 'accessory') return true;
  if (ACCESSORY_VARIANT_TYPES.has(sku.variant_type)) return true;

  // Tertiary signal: sell_by = 'unit' combined with vendor_sku containing trim codes
  const vsku = (sku.vendor_sku || '').toUpperCase();
  if (sku.sell_by === 'unit' && /(?:BN|CVB|JOLLY|LINER|OGEE|STP|VSLCAP|VQRND|SLIMT|VSCAP|COP|RNDSTRD|EXTSN|4IN1)/i.test(vsku)) {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

async function gatherMetrics(vendorId) {
  const [prodRes, skuRes, maxRes, skuImgRes, colorRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = 'active'`, [vendorId]),
    pool.query(`
      SELECT COUNT(*) FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT MAX(cnt) FROM (
        SELECT COUNT(*) as cnt FROM skus s JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
        GROUP BY s.product_id
      ) sub
    `, [vendorId]),
    pool.query(`
      SELECT COUNT(DISTINCT ma.sku_id) FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL AND p.status = 'active'
    `, [vendorId]),
    pool.query(`
      SELECT
        COUNT(DISTINCT s.id) FILTER (WHERE sa.value IS NOT NULL) as with_color,
        COUNT(DISTINCT s.id) as total
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
        AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
      WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
    `, [vendorId]),
  ]);

  const total = parseInt(colorRes.rows[0].total) || 1;
  const withColor = parseInt(colorRes.rows[0].with_color) || 0;

  return {
    products: parseInt(prodRes.rows[0].count),
    skus: parseInt(skuRes.rows[0].count),
    maxSkusPerProduct: parseInt(maxRes.rows[0].max) || 0,
    skuImages: parseInt(skuImgRes.rows[0].count),
    colorCoverage: ((withColor / total) * 100).toFixed(1),
  };
}

function printMetrics(m) {
  console.log(`  Active products:    ${m.products}`);
  console.log(`  Active SKUs:        ${m.skus}`);
  console.log(`  Max SKUs/product:   ${m.maxSkusPerProduct}`);
  console.log(`  SKU-level images:   ${m.skuImages}`);
  console.log(`  Color coverage:     ${m.colorCoverage}%`);
}

// ─────────────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
