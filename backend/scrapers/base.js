import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

export function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert a URL-style slug to Title Case.
 * "white-ribbon" → "White Ribbon"
 */
export function deslugify(slug) {
  if (!slug) return '';
  return slug
    // Restore fractions: "1-1-4" → "1\x001/4", "5-8" → "5/8"
    // Mixed numbers first: digit-digit-denominator where denominator is 2,3,4,8,16
    .replace(/(\d)-(\d+)-(\d+)/g, (m, whole, num, den) =>
      [2, 3, 4, 8, 16].includes(Number(den)) ? `${whole}\x00${num}/${den}` : m)
    // Simple fractions: digit-denominator (e.g., "5-8" → "5/8")
    .replace(/(\d)-(\d+)(?=[x×X\s-]|$)/g, (m, num, den) =>
      [2, 3, 4, 8, 16].includes(Number(den)) ? `${num}/${den}` : m)
    .replace(/[-_]+/g, ' ')
    .replace(/\x00/g, '-') // restore mixed-number hyphens (e.g., "1-1/4")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Normalize a size string: strip quotes/inch marks, collapse whitespace around "x".
 * "12 x 24" → "12x24", '12" x 24"' → "12x24"
 */
export function normalizeSize(raw) {
  if (!raw) return '';
  return raw
    .replace(/["″'']/g, '')
    .replace(/\s*[xX×]\s*/g, 'x')
    .trim();
}

/**
 * Build a variant name from size + optional qualifiers (finish, shape, etc.).
 * Filters out empty values, joins with ", ".
 * ("12x24", "Matte") → "12x24, Matte"
 * ("12x24", "Matte", "Mosaic") → "12x24, Matte, Mosaic"
 */
export function buildVariantName(size, ...qualifiers) {
  const parts = [normalizeSize(size), ...qualifiers].filter(Boolean);
  return parts.join(', ') || null;
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ──────────────────────────────────────────────
// Data validation — shared across all scrapers
// ──────────────────────────────────────────────

const VALID_PRODUCT_STATUSES = ['draft', 'active', 'inactive', 'discontinued'];
const VALID_SKU_STATUSES = ['active', 'draft', 'inactive'];
const VALID_SELL_BY = ['sqft', 'unit', 'sqyd'];
const VALID_VARIANT_TYPES = [null, 'accessory', 'floor_tile', 'wall_tile', 'mosaic', 'lvt', 'quarry_tile', 'stone_tile', 'floor_deco'];
const VALID_PRICE_BASIS = ['per_sqft', 'per_unit', 'per_sqyd', 'sqft', 'unit'];
const VALID_ASSET_TYPES = ['primary', 'alternate', 'lifestyle', 'spec_pdf', 'swatch'];

/**
 * Validate product data before upsert. Returns { valid, warnings, cleaned }.
 * `cleaned` contains sanitized values; `warnings` lists issues that were auto-fixed.
 * Throws on critical errors (missing required fields).
 */
export function validateProduct({ vendor_id, name, collection, category_id, description_short, description_long }) {
  const warnings = [];

  if (!vendor_id) throw new Error('validateProduct: vendor_id is required');
  if (!name || !name.trim()) throw new Error('validateProduct: name is required');

  let cleanName = name.trim();
  // Collapse excessive whitespace
  cleanName = cleanName.replace(/\s{2,}/g, ' ');
  if (cleanName !== name) warnings.push(`Product name whitespace normalized: "${name}" → "${cleanName}"`);

  // Detect suspiciously long names (likely parse errors)
  if (cleanName.length > 300) {
    warnings.push(`Product name unusually long (${cleanName.length} chars), truncating`);
    cleanName = cleanName.slice(0, 300);
  }

  let cleanCollection = (collection || '').trim().replace(/\s{2,}/g, ' ');

  return {
    valid: true,
    warnings,
    cleaned: { vendor_id, name: cleanName, collection: cleanCollection, category_id: category_id || null, description_short: description_short || null, description_long: description_long || null }
  };
}

/**
 * Validate SKU data before upsert. Returns { valid, warnings, cleaned }.
 */
export function validateSku({ product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type }) {
  const warnings = [];

  if (!product_id) throw new Error('validateSku: product_id is required');
  if (!internal_sku || !internal_sku.trim()) throw new Error('validateSku: internal_sku is required');

  let cleanVendorSku = (vendor_sku || '').trim();
  let cleanInternalSku = internal_sku.trim();
  let cleanVariantName = variant_name ? variant_name.trim().replace(/\s{2,}/g, ' ') : null;

  // Validate sell_by enum
  let cleanSellBy = sell_by || 'sqft';
  if (!VALID_SELL_BY.includes(cleanSellBy)) {
    warnings.push(`Invalid sell_by "${cleanSellBy}", defaulting to "sqft"`);
    cleanSellBy = 'sqft';
  }

  // Validate variant_type enum
  let cleanVariantType = variant_type || null;
  if (cleanVariantType && !VALID_VARIANT_TYPES.includes(cleanVariantType)) {
    warnings.push(`Invalid variant_type "${cleanVariantType}", setting to null`);
    cleanVariantType = null;
  }

  return {
    valid: true,
    warnings,
    cleaned: { product_id, vendor_sku: cleanVendorSku, internal_sku: cleanInternalSku, variant_name: cleanVariantName, sell_by: cleanSellBy, variant_type: cleanVariantType }
  };
}

/**
 * Validate pricing data before upsert. Returns { valid, warnings, cleaned }.
 */
export function validatePricing({ cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, map_price }) {
  const warnings = [];

  const parsedCost = cost != null ? parseFloat(cost) : null;
  const parsedRetail = retail_price != null ? parseFloat(retail_price) : null;

  // Price sanity checks
  if (parsedCost != null) {
    if (isNaN(parsedCost) || parsedCost < 0) {
      warnings.push(`Invalid cost "${cost}", setting to null`);
    } else if (parsedCost > 500) {
      warnings.push(`Unusually high cost: $${parsedCost}/unit — verify this is correct`);
    }
  }

  if (parsedRetail != null) {
    if (isNaN(parsedRetail) || parsedRetail < 0) {
      warnings.push(`Invalid retail_price "${retail_price}", setting to null`);
    } else if (parsedRetail > 1000) {
      warnings.push(`Unusually high retail price: $${parsedRetail}/unit — verify this is correct`);
    }
  }

  // Negative margin check
  if (parsedCost > 0 && parsedRetail > 0 && parsedCost > parsedRetail) {
    warnings.push(`Negative margin: cost $${parsedCost} > retail $${parsedRetail}`);
  }

  // Validate price_basis enum
  let cleanPriceBasis = price_basis || 'per_sqft';
  if (!VALID_PRICE_BASIS.includes(cleanPriceBasis)) {
    warnings.push(`Invalid price_basis "${cleanPriceBasis}", defaulting to "per_sqft"`);
    cleanPriceBasis = 'per_sqft';
  }

  return {
    valid: true,
    warnings,
    cleaned: {
      cost: (parsedCost != null && !isNaN(parsedCost) && parsedCost >= 0) ? parsedCost : null,
      retail_price: (parsedRetail != null && !isNaN(parsedRetail) && parsedRetail >= 0) ? parsedRetail : null,
      price_basis: cleanPriceBasis,
      cut_price: cut_price || null,
      roll_price: roll_price || null,
      cut_cost: cut_cost || null,
      roll_cost: roll_cost || null,
      roll_min_sqft: roll_min_sqft || null,
      map_price: map_price || null
    }
  };
}

/**
 * Validate packaging data. Returns { valid, warnings, cleaned }.
 */
export function validatePackaging({ sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft, roll_length_ft, freight_class }) {
  const warnings = [];

  const parsed = {
    sqft_per_box: sqft_per_box ? parseFloat(sqft_per_box) : null,
    pieces_per_box: pieces_per_box ? parseInt(pieces_per_box) : null,
    weight_per_box_lbs: weight_per_box_lbs ? parseFloat(weight_per_box_lbs) : null,
    boxes_per_pallet: boxes_per_pallet ? parseInt(boxes_per_pallet) : null,
    sqft_per_pallet: sqft_per_pallet ? parseFloat(sqft_per_pallet) : null,
    weight_per_pallet_lbs: weight_per_pallet_lbs ? parseFloat(weight_per_pallet_lbs) : null,
    roll_width_ft: roll_width_ft ? parseFloat(roll_width_ft) : null,
    roll_length_ft: roll_length_ft ? parseFloat(roll_length_ft) : null,
    freight_class: freight_class || null
  };

  // Sanity: sqft_per_box should be reasonable (0.1 to 200)
  if (parsed.sqft_per_box != null && (parsed.sqft_per_box <= 0 || parsed.sqft_per_box > 200)) {
    warnings.push(`Suspicious sqft_per_box: ${parsed.sqft_per_box}`);
  }

  // Sanity: weight_per_box should be reasonable (0.1 to 200 lbs)
  if (parsed.weight_per_box_lbs != null && (parsed.weight_per_box_lbs <= 0 || parsed.weight_per_box_lbs > 200)) {
    warnings.push(`Suspicious weight_per_box: ${parsed.weight_per_box_lbs} lbs`);
  }

  return { valid: true, warnings, cleaned: parsed };
}

/**
 * Log validation warnings to scrape job if job context available.
 * Call after validate*() to persist warnings for review.
 */
export async function logValidationWarnings(pool, jobId, skuRef, warnings) {
  if (!warnings.length || !jobId) return;
  const prefix = skuRef ? `[${skuRef}] ` : '';
  for (const w of warnings) {
    await appendLog(pool, jobId, `⚠ VALIDATION: ${prefix}${w}`);
  }
}

/**
 * Upsert product by (vendor_id, collection, name). Returns product id.
 * Automatically validates and sanitizes input before upserting.
 */
export async function upsertProduct(pool, rawData, opts = {}) {
  // Validate and sanitize
  const { warnings, cleaned } = validateProduct(rawData);
  if (warnings.length && opts.jobId) {
    logValidationWarnings(pool, opts.jobId, cleaned.name, warnings).catch(() => {});
  }

  const { vendor_id, name, collection, category_id, description_short, description_long } = cleaned;
  const slug = slugify((collection || '') + ' ' + name) || null;
  let result;
  try {
    result = await pool.query(`
      INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long, slug)
      VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
      ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
        category_id = COALESCE(EXCLUDED.category_id, products.category_id),
        description_short = COALESCE(EXCLUDED.description_short, products.description_short),
        description_long = COALESCE(EXCLUDED.description_long, products.description_long),
        slug = COALESCE(products.slug, EXCLUDED.slug),
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, (xmax = 0) AS is_new
    `, [vendor_id, name, collection || '', category_id || null, description_short || null, description_long || null, slug]);
  } catch (err) {
    // Slug collision — retry without slug (will be assigned by backfill script)
    if (err.code === '23505' && err.constraint === 'products_slug_unique') {
      result = await pool.query(`
        INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
        VALUES ($1, $2, $3, $4, 'draft', $5, $6)
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
          category_id = COALESCE(EXCLUDED.category_id, products.category_id),
          description_short = COALESCE(EXCLUDED.description_short, products.description_short),
          description_long = COALESCE(EXCLUDED.description_long, products.description_long),
          updated_at = CURRENT_TIMESTAMP
        RETURNING id, (xmax = 0) AS is_new
      `, [vendor_id, name, collection || '', category_id || null, description_short || null, description_long || null]);
    } else {
      throw err;
    }
  }
  // Refresh search vector for this product
  const productId = result.rows[0].id;
  pool.query('SELECT refresh_search_vectors($1)', [productId]).catch(() => {});
  return result.rows[0];
}

/**
 * Upsert SKU by internal_sku. Returns sku id.
 * Automatically validates and sanitizes input before upserting.
 */
export async function upsertSku(pool, rawData, opts = {}) {
  const { warnings, cleaned } = validateSku(rawData);
  if (warnings.length && opts.jobId) {
    logValidationWarnings(pool, opts.jobId, cleaned.internal_sku, warnings).catch(() => {});
  }

  const { product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type } = cleaned;
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = COALESCE(EXCLUDED.sell_by, skus.sell_by),
      variant_type = EXCLUDED.variant_type,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft', variant_type || null]);
  return result.rows[0];
}

/**
 * Normalize an attribute value based on its slug.
 * - size: strip quotes/inch marks, collapse whitespace around x → "12x24"
 * - color: title-case ALL CAPS values
 * - Other: trim whitespace
 */
export function normalizeAttributeValue(slug, value) {
  if (!value || !value.trim()) return null;
  let v = value.trim().replace(/\s{2,}/g, ' ');

  if (slug === 'size') {
    // Reject packaging quantities masquerading as sizes ("12 EA/CTN", "2 EA/CT")
    if (/\b(EA|CTN?|PCS?|BOX|PLT|GAL|OZ)\b/i.test(v)) return null;
    // Strip unit suffixes: "7.48 in" → "7.48", "12 inch" → "12", "300 mm" → "300"
    v = v.replace(/\s*(in|inch|inches|mm|cm)\s*$/i, '').trim();
    // Normalize sizes: "12" x 24"" → "12x24", "12 x 24" → "12x24"
    v = v.replace(/["″'']/g, '').replace(/\s*[xX×]\s*/g, 'x').trim();
    // Normalize common actual→nominal widths (e.g., 7.48" actual = 7.5" marketing)
    v = v.replace(/^7\.48$/, '7.5');
  } else if (slug === 'color') {
    // Title-case ALL CAPS colors: "AUTUMN GREY" → "Autumn Grey"
    if (v === v.toUpperCase() && v.length > 2 && /[A-Z]/.test(v)) {
      v = v.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }
  }

  return v;
}

/**
 * Upsert sku_attribute by (sku_id, attribute slug).
 * Looks up attribute_id from slug, then inserts or updates.
 * Automatically normalizes values based on attribute type.
 */
export async function upsertSkuAttribute(pool, sku_id, attributeSlug, value) {
  const normalized = normalizeAttributeValue(attributeSlug, value);
  if (!normalized) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [attributeSlug]);
  if (!attr.rows.length) return;
  const attribute_id = attr.rows[0].id;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attribute_id, normalized]);
}

/**
 * Append a log line to a scrape job and optionally update counters.
 */
export async function appendLog(pool, jobId, message, counters) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `[${timestamp}] ${message}\n`;
  let query = `UPDATE scrape_jobs SET log = log || $2`;
  const params = [jobId, line];
  let paramIdx = 3;

  if (counters) {
    if (counters.products_found != null) {
      query += `, products_found = $${paramIdx}`;
      params.push(counters.products_found);
      paramIdx++;
    }
    if (counters.products_created != null) {
      query += `, products_created = $${paramIdx}`;
      params.push(counters.products_created);
      paramIdx++;
    }
    if (counters.products_updated != null) {
      query += `, products_updated = $${paramIdx}`;
      params.push(counters.products_updated);
      paramIdx++;
    }
    if (counters.skus_created != null) {
      query += `, skus_created = $${paramIdx}`;
      params.push(counters.skus_created);
      paramIdx++;
    }
  }

  query += ` WHERE id = $1`;
  await pool.query(query, params);
}

/**
 * Upsert packaging by sku_id (PK). Returns nothing.
 * Automatically validates and sanitizes input before upserting.
 */
export async function upsertPackaging(pool, sku_id, rawData, opts = {}) {
  const { warnings, cleaned } = validatePackaging(rawData);
  if (warnings.length && opts.jobId) {
    logValidationWarnings(pool, opts.jobId, sku_id, warnings).catch(() => {});
  }

  const { sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft, roll_length_ft, freight_class } = cleaned;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft, roll_length_ft, freight_class)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
      weight_per_pallet_lbs = COALESCE(EXCLUDED.weight_per_pallet_lbs, packaging.weight_per_pallet_lbs),
      roll_width_ft = COALESCE(EXCLUDED.roll_width_ft, packaging.roll_width_ft),
      roll_length_ft = COALESCE(EXCLUDED.roll_length_ft, packaging.roll_length_ft),
      freight_class = COALESCE(EXCLUDED.freight_class, packaging.freight_class)
  `, [sku_id, sqft_per_box || null, pieces_per_box || null, weight_per_box_lbs || null, boxes_per_pallet || null, sqft_per_pallet || null, weight_per_pallet_lbs || null, roll_width_ft || null, roll_length_ft || null, freight_class || null]);
}

/**
 * Upsert pricing by sku_id (PK). Returns nothing.
 * Automatically validates and sanitizes input before upserting.
 */
export async function upsertPricing(pool, sku_id, rawData, opts = {}) {
  const { warnings, cleaned } = validatePricing(rawData);
  if (warnings.length && opts.jobId) {
    logValidationWarnings(pool, opts.jobId, sku_id, warnings).catch(() => {});
  }

  const { cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, map_price } = cleaned;
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, map_price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = COALESCE(EXCLUDED.cost, pricing.cost),
      retail_price = COALESCE(EXCLUDED.retail_price, pricing.retail_price),
      price_basis = COALESCE(EXCLUDED.price_basis, pricing.price_basis),
      cut_price = COALESCE(EXCLUDED.cut_price, pricing.cut_price),
      roll_price = COALESCE(EXCLUDED.roll_price, pricing.roll_price),
      cut_cost = COALESCE(EXCLUDED.cut_cost, pricing.cut_cost),
      roll_cost = COALESCE(EXCLUDED.roll_cost, pricing.roll_cost),
      roll_min_sqft = COALESCE(EXCLUDED.roll_min_sqft, pricing.roll_min_sqft),
      map_price = COALESCE(EXCLUDED.map_price, pricing.map_price)
  `, [sku_id, cost != null ? cost : null, retail_price != null ? retail_price : null, price_basis || 'per_sqft', cut_price || null, roll_price || null, cut_cost || null, roll_cost || null, roll_min_sqft || null, map_price || null]);
}

/**
 * Upsert inventory snapshot by (sku_id, warehouse). Used for scraped warehouse stock.
 */
export async function upsertInventorySnapshot(pool, sku_id, warehouse, { qty_on_hand_sqft, qty_in_transit_sqft }) {
  await pool.query(`
    INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand_sqft, qty_in_transit_sqft, snapshot_time, fresh_until)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '24 hours')
    ON CONFLICT (sku_id, warehouse) DO UPDATE SET
      qty_on_hand_sqft = EXCLUDED.qty_on_hand_sqft,
      qty_in_transit_sqft = EXCLUDED.qty_in_transit_sqft,
      snapshot_time = CURRENT_TIMESTAMP,
      fresh_until = CURRENT_TIMESTAMP + INTERVAL '24 hours'
  `, [sku_id, warehouse, qty_on_hand_sqft || 0, qty_in_transit_sqft || 0]);
}

/**
 * Add an error entry to a scrape job's errors JSONB array.
 */
export async function addJobError(pool, jobId, error) {
  await pool.query(`
    UPDATE scrape_jobs SET errors = errors || $2::jsonb WHERE id = $1
  `, [jobId, JSON.stringify([{ message: error, time: new Date().toISOString() }])]);
}

/**
 * Download an image from a URL to a local file path.
 * Creates parent directories as needed. Returns destPath on success, null on failure.
 */
export async function downloadImage(imageUrl, destPath) {
  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const resp = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) return null;
    await pipeline(resp.body, fs.createWriteStream(destPath));
    return destPath;
  } catch (err) {
    // Clean up partial file
    try { await fs.promises.unlink(destPath); } catch { }
    return null;
  }
}

/**
 * Upsert a media_assets row.
 * Uses separate partial unique indexes for SKU-level vs product-level images.
 * Returns { id, is_new }.
 */
export async function upsertMediaAsset(pool, { product_id, sku_id, asset_type, url, original_url, sort_order }) {
  // Always use HTTPS for image URLs
  if (url && url.startsWith('http://')) url = url.replace('http://', 'https://');
  const at = asset_type || 'primary';
  const so = sort_order || 0;
  const ou = original_url || null;

  let result;
  if (sku_id) {
    // SKU-level image: conflict on (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    result = await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET
        url = EXCLUDED.url,
        original_url = EXCLUDED.original_url
      RETURNING id, (xmax = 0) AS is_new
    `, [product_id, sku_id, at, url, ou, so]);
  } else {
    // Product-level image: conflict on (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    result = await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, $2, $3, $4, $5)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET
        url = EXCLUDED.url,
        original_url = EXCLUDED.original_url
      RETURNING id, (xmax = 0) AS is_new
    `, [product_id, at, url, ou, so]);
  }
  return result.rows[0];
}

/**
 * Extract file extension from an image URL. Defaults to '.jpg'.
 */
export function resolveImageExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
    if (match) return '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
  } catch { }
  return '.jpg';
}

/**
 * Extract large images from a page, filtering out icons, logos, and tiny elements.
 * Uses actual rendered dimensions (naturalWidth/naturalHeight) to exclude small images.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @param {Set<string>} [excludeUrls] - URLs to skip (e.g., site-wide images from collectSiteWideImages)
 * @param {number} [minDimension=150] - Minimum width AND height in pixels
 * @returns {Promise<Array<{src: string, width: number, height: number, alt: string}>>} sorted by area descending
 */
export async function extractLargeImages(page, excludeUrls = new Set(), minDimension = 150) {
  const EXCLUDE_PATTERNS = [
    'logo', 'icon', 'favicon', 'social', 'sprite', 'pixel', 'tracking',
    'blank', 'spacer', 'nav', 'menu', 'footer', 'header', 'badge', 'flag',
    'spinner', 'loader', 'avatar', 'arrow', 'caret', 'chevron', 'close',
    'search', 'cart', 'phone', 'email', 'map-pin', 'marker', 'play-btn',
    'share', 'print', 'pdf-icon', 'download-icon', 'ClaimU',
    '1x1', '1px', 'transparent.gif', 'transparent.png',
  ];

  const excludeArray = [...excludeUrls];

  return page.evaluate((excludePatterns, excludeUrlList, minDim) => {
    const results = [];
    const seen = new Set();

    for (const img of document.querySelectorAll('img')) {
      if (!img.complete || img.naturalHeight === 0) continue;
      if (img.naturalWidth < minDim || img.naturalHeight < minDim) continue;

      const src = img.currentSrc || img.src || img.dataset?.src || '';
      if (!src || !src.startsWith('http')) continue;

      const srcLower = src.toLowerCase();
      const srcClean = srcLower.split('?')[0];

      // Skip excluded URL patterns
      if (excludePatterns.some(p => srcLower.includes(p))) continue;

      // Skip site-wide images
      if (excludeUrlList.some(u => srcLower.includes(u.toLowerCase()))) continue;

      // Deduplicate by cleaned URL
      if (seen.has(srcClean)) continue;
      seen.add(srcClean);

      results.push({
        src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        alt: (img.alt || '').trim(),
      });
    }

    // Sort by pixel area descending (largest images first)
    results.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return results;
  }, EXCLUDE_PATTERNS, excludeArray, minDimension);
}

/**
 * Navigate to a brand's homepage and collect all image URLs present.
 * These represent site-wide elements (logos, banners, nav icons) that
 * should be excluded from product-specific image results.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @param {string} baseUrl - Brand homepage URL
 * @returns {Promise<Set<string>>} Set of image URLs to exclude
 */
export async function collectSiteWideImages(page, baseUrl) {
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    const urls = await page.evaluate(() => {
      const results = [];
      for (const img of document.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        if (src && src.startsWith('http')) {
          // Normalize: strip query params for comparison
          results.push(src.split('?')[0].toLowerCase());
        }
      }
      return results;
    });

    return new Set(urls);
  } catch {
    return new Set();
  }
}

/**
 * Fuzzy-match a scraped product name to a DB product name.
 * Returns a confidence score between 0 and 1.
 *
 * @param {string} scraped - Name from the vendor website
 * @param {string} dbName - Name from our database
 * @returns {number} Confidence score 0–1
 */
export function fuzzyMatch(scraped, dbName) {
  if (!scraped || !dbName) return 0;

  // Normalize: lowercase, strip punctuation, collapse whitespace
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const a = normalize(scraped);
  const b = normalize(dbName);

  if (!a || !b) return 0;

  // Exact match
  if (a === b) return 1;

  // Containment check
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Word overlap ratio
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;

  const jaccard = intersection.length / union.size;

  // Boost if all words from the shorter name are in the longer name
  const shorter = wordsA.size <= wordsB.size ? wordsA : wordsB;
  const longer = wordsA.size <= wordsB.size ? wordsB : wordsA;
  const allShorterInLonger = [...shorter].every(w => longer.has(w));
  if (allShorterInLonger && shorter.size >= 2) return Math.max(jaccard, 0.85);

  return jaccard;
}

// Keywords that suggest a lifestyle/room-scene image (module-level for reuse)
const LIFESTYLE_KEYWORDS = [
  'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
  'interior', 'kitchen', 'bath', 'bathroom', 'living', 'outdoor', 'pool',
  'backyard', 'application', 'install', 'showroom',
  'ambiance', 'vignette', 'hero', 'banner', 'header',
  'spotlight', 'promo', 'campaign', '1920x1080', '_4k',
  '.mp4', '.mov', '.webm',
  'amb0', 'amb1', '_amb_', '-amb-', 'amb_', 'ambi_',
  'crop_upscale',
  'ambience', 'gallery', 'roomview', 'room-view', 'insitu', 'in-situ',
  'inspiration', 'decor', 'styled', 'design',
];

/**
 * Check whether a URL looks like a lifestyle/room-scene image based on filename keywords.
 * @param {string} url
 * @returns {boolean}
 */
export function isLifestyleUrl(url) {
  const filename = url.toLowerCase().split('/').pop().split('?')[0];
  return LIFESTYLE_KEYWORDS.some(kw => filename.includes(kw));
}

/**
 * Sort image URLs to prefer product-only shots (white/transparent background)
 * over lifestyle/room-scene images. Returns a new sorted array (does not mutate).
 *
 * Philosophy: TRUST the vendor's original gallery order by default. Only re-rank
 * when there's a strong signal (lifestyle keyword → demote, or known product-shot
 * pattern → promote). When scores tie, the vendor's original order is preserved.
 *
 * Use as: const sorted = preferProductShot(imageUrls, 'colorName');
 * Or with variant hints: preferProductShot(imageUrls, 'colorName', { size: '12x12', finish: 'Honed' });
 */
export function preferProductShot(urls, colorHint, variantHints) {
  if (!urls || urls.length <= 1) return urls || [];

  // Strong indicators of a clean product shot (swatch on white/transparent bg)
  const PRODUCT_KEYWORDS = [
    'swatch', 'chip', 'product', 'closeup', 'close-up',
    'sample', 'solo', 'isolated', 'cutout', 'cut-out', 'studio',
    'white-bg', 'transparent', 'no-bg', 'nobg', 'variation', 'resize',
  ];

  // LIFESTYLE_KEYWORDS is defined at module level (shared with isLifestyleUrl)

  // Normalize color hint for URL matching
  const colorSlug = colorHint
    ? colorHint.toLowerCase().replace(/[^a-z0-9]+/g, '')
    : null;

  // Normalize variant hints for URL matching (e.g., "12x12" → "12x12", "Honed" → "honed")
  const sizeSlug = variantHints?.size
    ? variantHints.size.toLowerCase().replace(/[^a-z0-9x]+/g, '') : null;
  const finishSlug = variantHints?.finish
    ? variantHints.finish.toLowerCase().replace(/[^a-z0-9]+/g, '') : null;

  function scoreUrl(url, originalIndex) {
    const lower = url.toLowerCase();
    const filename = lower.split('/').pop().split('?')[0];
    let score = 0;

    // PNG files are more likely to have transparent backgrounds
    if (filename.endsWith('.png')) score += 2;

    // Arizona Tile convention: filenames ending in -P before the extension are product shots
    if (/-p\.\w+$/.test(filename)) score += 6;

    for (const kw of PRODUCT_KEYWORDS) {
      if (filename.includes(kw)) { score += 3; break; }
    }
    for (const kw of LIFESTYLE_KEYWORDS) {
      if (filename.includes(kw)) { score -= 20; break; }
    }

    // Color-aware boost: if URL filename contains the color name, it's likely
    // the right product shot for this color (not a shared/wrong-color image)
    if (colorSlug && colorSlug.length >= 3) {
      if (filename.includes(colorSlug)) score += 5;
    }

    // Variant-aware boost: prefer images whose filename matches the specific size and finish
    const fnNorm = filename.replace(/[^a-z0-9x]+/g, '');
    if (sizeSlug && sizeSlug.length >= 3 && fnNorm.includes(sizeSlug)) score += 8;
    if (finishSlug && finishSlug.length >= 3 && fnNorm.includes(finishSlug)) score += 8;

    // Stable sort: preserve vendor's original gallery order as tiebreaker.
    // A tiny penalty per position ensures original order wins when scores are equal.
    score -= originalIndex * 0.001;

    return score;
  }

  const sorted = urls
    .map((url, i) => ({ url, score: scoreUrl(url, i) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.url);

  // Hard guarantee: lifestyle image must never be primary
  if (sorted.length > 1 && isLifestyleUrl(sorted[0])) {
    const firstNonLifestyle = sorted.findIndex(u => !isLifestyleUrl(u));
    if (firstNonLifestyle > 0) {
      const swap = sorted[firstNonLifestyle];
      sorted[firstNonLifestyle] = sorted[0];
      sorted[0] = swap;
    }
  }

  return sorted;
}

/**
 * Filter a set of images down to those relevant to a specific color/variant.
 * Checks filenames and alt text for color-related signals.
 *
 * @param {Array<{url: string, alt?: string}> | string[]} images - Image objects or URL strings
 * @param {string} colorName - e.g. "Autumn Grey"
 * @param {object} [opts]
 * @param {string[]} [opts.otherColors] - Names of OTHER colors on this page (for exclusion)
 * @param {string} [opts.productName] - Product name (treated as neutral, not a color signal)
 * @returns {{ matched: string[], shared: string[] }}
 */
export function filterImagesByVariant(images, colorName, opts = {}) {
  if (!images || !images.length || !colorName) {
    const urls = (images || []).map(img => typeof img === 'string' ? img : img.url);
    return { matched: [], shared: urls };
  }

  const { otherColors = [], productName } = opts;

  // Normalize to slug: "Autumn Grey" → "autumngrey"
  const toSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Individual words (min 3 chars to avoid noise like "el", "de")
  const toWords = (s) => s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length >= 3);

  const targetSlug = toSlug(colorName);
  const targetWords = toWords(colorName);

  // Build exclusion slugs from other colors
  const otherSlugs = otherColors
    .map(c => toSlug(c))
    .filter(s => s.length >= 3 && s !== targetSlug);

  // Product name words are neutral (should not count as color signals)
  const neutralWords = new Set(productName ? toWords(productName) : []);

  const matched = [];
  const shared = [];

  for (const img of images) {
    const url = typeof img === 'string' ? img : img.url;
    const alt = (typeof img === 'string' ? '' : img.alt) || '';

    // Build search text from filename + alt
    const filename = url.toLowerCase().split('/').pop().split('?')[0];
    const searchText = filename + ' ' + alt.toLowerCase();
    const searchSlug = toSlug(searchText);

    // Check for positive match (target color)
    const hasTargetSlug = targetSlug.length >= 3 && searchSlug.includes(targetSlug);
    const targetWordsFiltered = targetWords.filter(w => !neutralWords.has(w));
    const hasAllTargetWords = targetWordsFiltered.length > 0 &&
      targetWordsFiltered.every(w => searchText.includes(w));

    // Check for negative match (another color)
    const hasOtherColor = otherSlugs.some(slug => searchSlug.includes(slug));

    if (hasTargetSlug || hasAllTargetWords) {
      matched.push(url);
    } else if (hasOtherColor) {
      // Skip — belongs to another color
    } else {
      shared.push(url);
    }
  }

  return { matched, shared };
}

/**
 * Extract PDF links from a page, filtered to spec/technical documents.
 * Returns array of { url, label } objects.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @returns {Promise<Array<{url: string, label: string}>>}
 */
export async function extractSpecPDFs(page) {
  const SPEC_KEYWORDS = [
    'spec', 'technical', 'install', 'maintenance', 'warranty',
    'care', 'data sheet', 'datasheet', 'guide', 'brochure',
  ];

  return page.evaluate((keywords) => {
    const results = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = (a.getAttribute('href') || '').trim();
      if (!href.match(/\.pdf(\?|#|$)/i)) continue;
      const url = href.startsWith('http') ? href : new URL(href, location.origin).href;
      const urlLower = url.toLowerCase();
      if (seen.has(urlLower)) continue;
      const label = (a.textContent || '').trim() || (a.getAttribute('title') || '').trim() || '';
      const combined = (label + ' ' + urlLower).toLowerCase();
      if (keywords.some(kw => combined.includes(kw))) {
        seen.add(urlLower);
        results.push({ url, label: label || url.split('/').pop().replace('.pdf', '') });
      }
    }
    return results;
  }, SPEC_KEYWORDS);
}

/**
 * Normalize Tri-West product names for better matching against manufacturer sites.
 *
 * - Strips "Brand - " prefix from collection names (e.g., "Provenza - ICONIC" → "ICONIC")
 * - Title-cases ALL-CAPS color names (e.g., "AUTUMN GREY" → "Autumn Grey")
 * - Removes trailing dimension strings already captured as size attributes
 *
 * @param {string} rawName - Raw name from Tri-West DNav portal
 * @returns {string} Normalized name
 */
export function normalizeTriwestName(rawName) {
  if (!rawName) return '';
  let name = rawName.trim();

  // Strip "Brand - " prefix (handles "Provenza - ICONIC", "Shaw - Floorte Pro", etc.)
  name = name.replace(/^[A-Za-z][A-Za-z\s&.-]+\s*[-–—]\s*/, '');

  // Remove trailing dimension strings like "12x24", "7" x 48"", "3/4 x 5"
  name = name.replace(/\s+\d+["″']?\s*[xX×]\s*\d+["″']?\s*$/, '');
  name = name.replace(/\s+\d+\/\d+\s*[xX×]\s*\d+["″']?\s*$/, '');

  // Title-case if ALL CAPS (2+ words all uppercase)
  if (name === name.toUpperCase() && name.includes(' ')) {
    name = name
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  return name.trim();
}

// ──────────────────────────────────────────────
// Image guardrails — shared utilities for scrapers
// ──────────────────────────────────────────────

/**
 * URL-based junk filter for image arrays (no Puppeteer needed).
 * Use this when you already have a list of image URL strings and want to
 * strip logos, icons, placeholders, social assets, and other non-product junk.
 *
 * Also deduplicates by stripping WordPress thumbnail dimension suffixes
 * (e.g., -300x200.jpg → .jpg) and query strings before comparing.
 *
 * @param {string[]} urls - Raw image URLs
 * @param {object} [opts]
 * @param {number} [opts.maxImages=8] - Maximum images to return
 * @param {string[]} [opts.extraExclude] - Additional substrings to reject
 * @returns {string[]} Cleaned, deduplicated URLs (order preserved)
 */
export function filterImageUrls(urls, opts = {}) {
  const { maxImages = 8, extraExclude = [] } = opts;

  const EXCLUDE = [
    'logo', 'icon', 'favicon', 'social', 'sprite', 'pixel', 'tracking',
    'blank', 'spacer', 'nav', 'menu', 'footer', 'header', 'badge', 'flag',
    'spinner', 'loader', 'avatar', 'arrow', 'caret', 'chevron', 'close',
    'search', 'cart', 'phone', 'email', 'map-pin', 'marker', 'play-btn',
    'share', 'print', 'pdf-icon', 'download-icon',
    '1x1', '1px', 'transparent.gif', 'transparent.png',
    'placeholder', 'woocommerce-placeholder',
    'gravatar', 'wp-emoji', 'smilies',
    ...extraExclude,
  ];

  const seen = new Set();
  const result = [];

  for (const rawUrl of urls) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    const lower = rawUrl.toLowerCase();

    // Must be an absolute URL
    if (!lower.startsWith('http')) continue;

    // Reject junk patterns
    if (EXCLUDE.some(p => lower.includes(p))) continue;

    // Reject non-image extensions
    const path = lower.split('?')[0];
    if (path.match(/\.(svg|pdf|mp4|webm|gif)$/)) continue;

    // Normalize: strip WP thumbnail suffixes and query strings for dedup
    const normalized = path.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // Keep the full-size version (strip WP thumbnail suffix from actual URL)
    result.push(rawUrl.replace(/-\d+x\d+(\.[a-zA-Z]+)(\?|$)/, '$1$2'));

    if (result.length >= maxImages) break;
  }

  return result;
}

/**
 * Save images at the PRODUCT level (sku_id = NULL).
 * This is the correct default for scrapers where all SKUs of a product share
 * the same images. The storefront API falls back to product-level images when
 * no SKU-level images exist.
 *
 * Assigns asset types: index 0 → primary, 1-2 → alternate, 3+ → lifestyle.
 *
 * @param {import('pg').Pool} pool - Database pool
 * @param {number} productId - Product ID
 * @param {string[]} imageUrls - Already-filtered image URLs (use filterImageUrls first)
 * @param {object} [opts]
 * @param {number} [opts.maxImages=6] - Max images to save
 * @returns {Promise<number>} Number of images saved
 */
export async function saveProductImages(pool, productId, imageUrls, opts = {}) {
  const { maxImages = 6 } = opts;
  const toSave = imageUrls.slice(0, maxImages);

  // Safety net: ensure a lifestyle image is never stored as primary
  if (toSave.length > 1 && isLifestyleUrl(toSave[0])) {
    const swapIdx = toSave.findIndex(u => !isLifestyleUrl(u));
    if (swapIdx > 0) [toSave[0], toSave[swapIdx]] = [toSave[swapIdx], toSave[0]];
  }

  let saved = 0;

  for (let i = 0; i < toSave.length; i++) {
    const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
    await upsertMediaAsset(pool, {
      product_id: productId,
      sku_id: null,
      asset_type: assetType,
      url: toSave[i],
      original_url: toSave[i],
      sort_order: i,
    });
    saved++;
  }

  return saved;
}

/**
 * Save images at the SKU level (sku_id set).
 * Use when a scraper page is known to show images for a single specific SKU/color.
 * The storefront API prefers SKU-level images over product-level ones.
 *
 * Assigns asset types: index 0 → primary, 1-2 → alternate, 3+ → lifestyle.
 *
 * @param {import('pg').Pool} pool - Database pool
 * @param {number} productId - Product ID
 * @param {number} skuId - SKU ID
 * @param {string[]} imageUrls - Already-filtered image URLs (use filterImageUrls first)
 * @param {object} [opts]
 * @param {number} [opts.maxImages=8] - Max images to save
 * @returns {Promise<number>} Number of images saved
 */
export async function saveSkuImages(pool, productId, skuId, imageUrls, opts = {}) {
  const { maxImages = 8 } = opts;
  const toSave = imageUrls.slice(0, maxImages);

  // Safety net: ensure a lifestyle image is never stored as primary
  if (toSave.length > 1 && isLifestyleUrl(toSave[0])) {
    const swapIdx = toSave.findIndex(u => !isLifestyleUrl(u));
    if (swapIdx > 0) [toSave[0], toSave[swapIdx]] = [toSave[swapIdx], toSave[0]];
  }

  let saved = 0;

  for (let i = 0; i < toSave.length; i++) {
    const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
    await upsertMediaAsset(pool, {
      product_id: productId,
      sku_id: skuId,
      asset_type: assetType,
      url: toSave[i],
      original_url: toSave[i],
      sort_order: i,
    });
    saved++;
  }

  return saved;
}
