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
 * Upsert product by (vendor_id, name). Returns product id.
 */
export async function upsertProduct(pool, { vendor_id, name, collection, category_id, description_short, description_long }) {
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1, $2, $3, $4, 'draft', $5, $6)
    ON CONFLICT ON CONSTRAINT products_vendor_name_unique DO UPDATE SET
      collection = COALESCE(EXCLUDED.collection, products.collection),
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      description_long = COALESCE(EXCLUDED.description_long, products.description_long),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendor_id, name, collection || null, category_id || null, description_short || null, description_long || null]);
  return result.rows[0];
}

/**
 * Upsert SKU by internal_sku. Returns sku id.
 */
export async function upsertSku(pool, { product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type }) {
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      variant_type = COALESCE(EXCLUDED.variant_type, skus.variant_type),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft', variant_type || null]);
  return result.rows[0];
}

/**
 * Upsert sku_attribute by (sku_id, attribute slug).
 * Looks up attribute_id from slug, then inserts or updates.
 */
export async function upsertSkuAttribute(pool, sku_id, attributeSlug, value) {
  if (!value || !value.trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [attributeSlug]);
  if (!attr.rows.length) return;
  const attribute_id = attr.rows[0].id;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attribute_id, value.trim()]);
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
 */
export async function upsertPackaging(pool, sku_id, { sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
      weight_per_pallet_lbs = COALESCE(EXCLUDED.weight_per_pallet_lbs, packaging.weight_per_pallet_lbs)
  `, [sku_id, sqft_per_box || null, pieces_per_box || null, weight_per_box_lbs || null, boxes_per_pallet || null, sqft_per_pallet || null, weight_per_pallet_lbs || null]);
}

/**
 * Upsert pricing by sku_id (PK). Returns nothing.
 */
export async function upsertPricing(pool, sku_id, { cost, retail_price, price_basis }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = COALESCE(EXCLUDED.cost, pricing.cost),
      retail_price = COALESCE(EXCLUDED.retail_price, pricing.retail_price),
      price_basis = COALESCE(EXCLUDED.price_basis, pricing.price_basis)
  `, [sku_id, cost || 0, retail_price || 0, price_basis || 'per_sqft']);
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
    try { await fs.promises.unlink(destPath); } catch {}
    return null;
  }
}

/**
 * Upsert a media_assets row by (product_id, asset_type, sort_order).
 * Returns { id, is_new }.
 */
export async function upsertMediaAsset(pool, { product_id, sku_id, asset_type, url, original_url, sort_order }) {
  const result = await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT ON CONSTRAINT media_assets_unique DO UPDATE SET
      url = EXCLUDED.url,
      original_url = EXCLUDED.original_url,
      sku_id = EXCLUDED.sku_id
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, sku_id || null, asset_type || 'primary', url, original_url || null, sort_order || 0]);
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
  } catch {}
  return '.jpg';
}
