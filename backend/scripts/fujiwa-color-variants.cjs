#!/usr/bin/env node
/**
 * Fujiwa color variants scraper & importer.
 *
 * Fujiwa's WooCommerce site exposes every tile series as a variable product
 * whose color variants live in `form.variations_form[data-product_variations]`
 * as a JSON blob. Each variation includes:
 *    - sku            (e.g. "BOHOL-HILLS", "JOYA-101")
 *    - attribute_pa_colors  (e.g. "bohol-hills", "joya-101-verde")
 *    - image.full_src  (per-color 645×184 strip image)
 *
 * Our DB used to hold a SINGLE size-based SKU per series (e.g. BOHOL, 6"x6")
 * with the "Color" attribute bogusly set to the series name. This script:
 *
 *   1. Visits every series URL, parses the variations JSON.
 *   2. For each URL → size pair, finds the matching DB "template" SKU
 *      (same product, same size) and uses it as a blueprint for cost/price/
 *      packaging.
 *   3. Replaces the template SKU with one new SKU per color variation.
 *      Copies pricing + packaging + non-color sku_attributes across.
 *   4. Attaches the variation's per-color image as that SKU's primary media.
 *   5. Sets sku_attributes.Color to the real color name (parsed from the
 *      pa_colors slug, e.g. "joya-101-verde" → "Verde").
 *
 * Safe to re-run: uses vendor_sku as the stable identifier for new SKUs, so
 * subsequent runs upsert instead of duplicating.
 *
 * Usage:
 *   docker compose exec api node /app/scripts/fujiwa-color-variants.cjs
 *   docker compose exec api node /app/scripts/fujiwa-color-variants.cjs BOHOL       # single series
 *   docker compose exec api node /app/scripts/fujiwa-color-variants.cjs BOHOL JOYA  # subset
 */

const { Client } = require('pg');
const puppeteer = require('puppeteer');

const FUJIWA_VENDOR_ID = '8ec5135f-8ded-4818-925e-2ca70bef4c0a';
const BASE_URL = 'https://www.fujiwatiles.com/products/fujiwa-tile-collections/';

const ATTR_COLOR    = 'd50e8400-e29b-41d4-a716-446655440001';
const ATTR_MATERIAL = 'd50e8400-e29b-41d4-a716-446655440002';
const ATTR_SIZE     = 'd50e8400-e29b-41d4-a716-446655440004';
const ATTR_BRAND    = '4d2dd076-ea5c-4bf3-89fb-bc6fc2cefeda';

// ---------------------------------------------------------------------------
// SERIES_MAP: series product code → array of { slug, size } pairs
//
// Each (slug, size) pair identifies one Fujiwa series page that should map
// to an existing DB SKU with the given variant_name (size). When a series
// has multiple sizes (e.g. Joya: 100/300/600/deco), each URL maps to its
// own size.
//
// `code` matches the product code used by import-fujiwa.js — we find the
// product by looking up any existing SKU whose vendor_sku starts with this
// code or whose internal_sku contains it.
// ---------------------------------------------------------------------------
const SERIES_MAP = {
  ALCO:       [{ slug: 'alco-deco-series',       size: '6" Akron' }],
  ALEX:       [{ slug: 'alex-series',            size: '3" x 3"' }],
  AMBON:      [{ slug: 'ambon-deco-series',      size: '6" Akron' }],
  BOHOL:      [{ slug: 'bohol-series',           size: '6" x 6"' }],
  BORA:       [{ slug: 'bora-600-series',        size: '6" x 6"' }],
  CEL:        [{ slug: 'celica-series',          size: '2" x 2"', dbPrefix: 'CELICA' }],
  CRESTA:     [{ slug: 'cresta-series',          size: '4" x 4"' }],
  EROS:       [
    { slug: 'eros-100-series', size: '1-1/8" x 1-1/8"' },
    { slug: 'eros-600-series', size: '6" x 6"' },
  ],
  FGM:        [{ slug: 'fgm-series',             size: '3/4" x 3/4" Glass' }],
  FLORA:      [{ slug: 'flora-series',           size: '6" x 6"' }],
  FUJI:       [{ slug: 'fuji-series',            size: '4" x 4"' }],
  GLASSTEL:   [{ slug: 'glasstel-series',        size: '7/8" x 1 7/8"' }],
  GS:         [{ slug: 'gloss-solid-series',     size: '6" x 6" Glossy Solid', dbPrefix: 'GLOSS-SOLID' }],
  HEX:        [{ slug: 'hex-series',             size: '1" Hexagon' }],
  INKA:       [{ slug: 'inka-series',            size: '6" x 6"' }],
  JAVA:       [{ slug: 'java-series',            size: '6" x 6"' }],
  JOYA:       [
    { slug: 'joya-100-series',  size: '1" x 1"' },
    { slug: 'joya-300-series',  size: '3" x 3"' },
    { slug: 'joya-600-series',  size: '6" x 6"' },
    { slug: 'joya-deco-series', size: '6" Akron' },
  ],
  KASURI:     [{ slug: 'kasuri-series',          size: '6" x 6"' }],
  KAWA:       [{ slug: 'kawa-series',            size: '6" x 6"' }],
  KENJI:      [{ slug: 'kenji-series',           size: '6" x 6"' }],
  KLM:        [{ slug: 'klm-series',             size: '3" x 3"' }],
  KOLN:       [{ slug: 'koln-series',            size: '2" x 6"' }],
  LANTERN:    [
    { slug: 'lantern-series',          size: '2" Arabesque (Matte)' },
    // Note: Lantern also has a Metallic SKU (LANTERN-MT). Fujiwa's site only
    // has the one series page; we keep the Metallic SKU untouched.
  ],
  LEGACY:     [{ slug: 'legacy-series',          size: '2" Random Block' }],
  LICATA:     [{ slug: 'licata-series',          size: '1 1/8" x 2 1/4"' }],
  LOMBO:      [{ slug: 'lombo-series',           size: '1/2" x 3 1/4" Non Metallic' }],
  LUNAR:      [{ slug: 'lunar-series',           size: '6" x 6"' }],
  LYRA:       [{ slug: 'lyra-600-series',        size: '6" x 6"' }],
  NAMI:       [
    { slug: 'nami-100-series', size: '1-1/8" x 1-1/8"' },
    { slug: 'nami-600-series', size: '6" x 6"' },
  ],
  NET:        [{ slug: 'net-600-series',         size: '6"' }],
  OMEGA:      [{ slug: 'omega-series',           size: 'Random' }],
  PAD:        [{ slug: 'pad-series',             size: '1" x 1"' }],
  PATINA:     [{ slug: 'patina-series',          size: '6" x 6"' }],
  PEB:        [{ slug: 'peb-series',             size: '1" x 1"' }],
  PEBBLESTONE:[{ slug: 'pebblestone-series',     size: 'Pebblestone', dbPrefix: 'PEBBLE' }],
  PILOS:      [{ slug: 'pilos-series',           size: 'Random' }],
  PLANET:     [
    { slug: 'planet-series',     size: '1" x 1"' },
    { slug: 'planet-300-series', size: '3" x 3"' },
    { slug: 'planet-600-series', size: '6" x 6"' },
  ],
  PNR:        [{ slug: 'penny-round-series',     size: '3/4" Penny Round' }],
  PRIMA:      [{ slug: 'prima-series',           size: '4" x 4"' }],
  QUARZO:     [{ slug: 'quarzo-series',          size: '6 1/4" x 16"' }],
  RIO:        [{ slug: 'rio-series',             size: '6" x 6"' }],
  RIVERA:     [{ slug: 'rivera-series',          size: '1" x 2 1/4"' }],
  RUST:       [{ slug: 'rust-series',            size: '3" x 3"' }],
  SAGA:       [
    { slug: 'saga-100-series', size: '1-1/8" x 1-1/8"' },
    { slug: 'saga-600-series', size: '6" x 6"' },
  ],
  SEKIS:      [{ slug: 'sekis-series',           size: '6" x 6"' }],
  SIERRA:     [{ slug: 'sierra-series',          size: '6" x 6"' }],
  SMALT:      [{ slug: 'smalt-art-series',       size: '6" x 6"' }],
  SORA:       [{ slug: 'sora-700-series',        size: '6" x 6"' }],
  STAK:       [{ slug: 'stak-deco-series',       size: '6" Akron' }],
  STAR:       [{ slug: 'stardon-series',         size: '6" x 6"', dbPrefix: 'STARDON' }],
  STONELEDGE: [{ slug: 'stoneledge-series',      size: '6" x 6"' }],
  STQ:        [{ slug: 'stq-series',             size: '1" x 1"' }],
  STS:        [{ slug: 'sts-series',             size: '3" x 3"' }],
  SYDNEY:     [{ slug: 'sydney-series',          size: '6" Akron' }],
  TILIS:      [{ slug: 'tilis-series',           size: '6" x 13-3/4" Listello' }],
  TITAN:      [
    { slug: 'titan-300-series',      size: '3" x 3"' },
    { slug: 'titan-600-deco-series', size: '6" Akron' },
    { slug: 'titan-700-series',      size: '6" x 6"' },
  ],
  TNT:        [{ slug: 'tnt-series',             size: '1" x 1"' }],
  TOKYO:      [
    { slug: 'tokyo-100-series', size: '1-1/8" x 1-1/8"' },
    { slug: 'tokyo-200-series', size: '2" x 3"' },
    { slug: 'tokyo-600-series', size: '6" x 6"' },
  ],
  UNG:        [
    { slug: 'unglazed-100-series', size: '1" & 2" Black & White' },
    { slug: 'unglazed-200-series', size: '1" & 2" Blue' },
  ],
  VENIZ:      [{ slug: 'veniz-series',           size: '3" x 3"' }],
  VIGAN:      [{ slug: 'vigan-series',           size: '6" x 6"' }],
  VINTA:      [{ slug: 'vinta-series',           size: '2" x 4"' }],
  'VIP/S':    [{ slug: 'vip-series',             size: '3" x 3"', dbPrefix: 'VIP' }],
  YOMBA:      [{ slug: 'yomba-series',           size: '6" x 6"' }],
  YUCCA:      [{ slug: 'yuca-series',            size: '6" x 6"', dbPrefix: 'YUCA' }],
};

// ---------------------------------------------------------------------------
// Colour-name extraction
//
//   bohol-hills            (series=bohol)     → "Hills"
//   joya-101-verde         (series=joya)      → "Verde"
//   joya-501-verde         (series=joya, deco)→ "Verde"
//   tokyo-101-icy-blue     (series=tokyo)     → "Icy Blue"
//   unglazed-100-black     (series=unglazed)  → "Black"
//
// Algorithm: strip the series slug prefix + any leading numeric chunk, then
// titlecase the remainder.
// ---------------------------------------------------------------------------
// Known pa_colors prefix aliases — when the WooCommerce slug abbreviation
// differs from the URL slug or series code.
const PA_ALIASES = {
  'glasstel': 'glasstell',     // site uses double-L in pa_colors
  'pebblestone': 'pebble',     // shortened in pa_colors
};

function extractColorName(paColors, seriesBaseSlug, seriesCode) {
  if (!paColors) return null;
  let s = paColors.toLowerCase();

  // Build ordered list of prefixes to try (longest first so compound prefixes
  // like "titan-deco" match before "titan").
  const prefixes = [];
  if (seriesBaseSlug) {
    prefixes.push(seriesBaseSlug + '-deco');
    prefixes.push(seriesBaseSlug);
  }
  const alias = PA_ALIASES[seriesBaseSlug];
  if (alias) {
    prefixes.push(alias + '-deco');
    prefixes.push(alias);
  }
  if (seriesCode) {
    const codeLower = seriesCode.toLowerCase().replace('/', '-');
    if (!prefixes.includes(codeLower)) {
      prefixes.push(codeLower + '-deco');
      prefixes.push(codeLower);
    }
  }

  for (const pfx of prefixes) {
    if (s.startsWith(pfx + '-')) {
      s = s.substring(pfx.length + 1);
      break;
    }
  }

  // Strip leading alphanumeric code (e.g. "101", "100c", "761mt", "3428")
  s = s.replace(/^\d+[a-z]*-?/, '');
  // Strip residual "deco-" that may remain after prefix stripping
  s = s.replace(/^deco-?/, '');
  // Second pass for numeric code after deco removal
  s = s.replace(/^\d+[a-z]*-?/, '');
  // Clean edges
  s = s.replace(/^-+|-+$/g, '');
  if (!s) return null;

  return s.split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Derive a unique vendor_sku from pa_colors when the scraped v.sku collides
// across all colour variations (e.g. Penny Round, where every variation has
// sku="3/4\" Penny Round"). Returns null if we can't derive something useful.
function deriveVendorSkuFromPaColors(paColors, seriesCode) {
  if (!paColors) return null;
  // pa_colors looks like "pnr-3428-marble-blue" → numeric part "3428"
  const m = paColors.match(/^[a-z-]*?(\d+)-/);
  if (m) return (seriesCode.replace('/', '-') + '-' + m[1]).toUpperCase();
  // Fall back: uppercase full slug minus series prefix
  return (seriesCode.replace('/', '-') + '-' + paColors.replace(/^[a-z]+-/, '').replace(/-/g, '_')).toUpperCase();
}

// The "base slug" of a series (for colour parsing) is the URL slug with any
// `-<number>`-series or `-series` suffix removed.
//   joya-100-series        → joya
//   penny-round-series     → penny-round
//   unglazed-100-series    → unglazed
function slugToBase(slug) {
  return slug
    .replace(/-series$/, '')
    .replace(/-\d+$/, '')
    .replace(/-\d+-deco$/, '-deco')
    .replace(/-deco$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Puppeteer: visit a series page and return its color variations
// ---------------------------------------------------------------------------
async function scrapeSeries(page, slug) {
  const url = BASE_URL + slug + '/';
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    if (!resp || resp.status() >= 400) {
      console.log('    [HTTP ' + (resp && resp.status()) + '] ' + url);
      return [];
    }
  } catch (e) {
    console.log('    Nav failed ' + slug + ': ' + e.message);
    return [];
  }

  try {
    const variations = await page.evaluate(() => {
      const form = document.querySelector('form.variations_form');
      if (!form) return [];
      try {
        const raw = form.getAttribute('data-product_variations') || '[]';
        return JSON.parse(raw);
      } catch (e) { return []; }
    });

    return variations
      .filter(v => v && v.sku)
      .map(v => ({
        sku: v.sku,
        pa_colors: (v.attributes && v.attributes.attribute_pa_colors) || '',
        image_url: (v.image && (v.image.full_src || v.image.url || v.image.src)) || null,
      }));
  } catch (e) {
    console.log('    Extract failed ' + slug + ': ' + e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

// Find the DB product + "template" SKU that corresponds to a (seriesCode, size)
// pair. The template SKU gives us pricing, packaging, and packaging metadata
// to inherit across the new per-color SKUs.
//
// On first run the template is the legacy single-size SKU (e.g. BOHOL → 6"x6").
// On re-runs the legacy template has been deleted — fall back to any existing
// per-color SKU for the same product (they already carry the right pricing).
async function findTemplateSku(client, seriesCode, size) {
  const safeCode = seriesCode.replace('/', '-');
  // Attempt 1: original template by variant_name = size
  const res = await client.query(
    `SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.internal_sku,
            s.variant_name, s.sell_by, s.variant_type, s.is_sample, s.status,
            pr.cost, pr.retail_price, pr.price_basis,
            pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
            pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet,
            pk.weight_per_pallet_lbs
       FROM skus s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN pricing pr ON pr.sku_id = s.id
       LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.vendor_id = $1
        AND s.variant_name = $2
        AND (s.vendor_sku = $3
             OR s.vendor_sku LIKE $3 || '-%'
             OR s.internal_sku = 'FUJIWA-' || $3
             OR s.internal_sku LIKE 'FUJIWA-' || $3 || '-%')
      LIMIT 1`,
    [FUJIWA_VENDOR_ID, size, safeCode]
  );
  if (res.rows[0]) return { ...res.rows[0], _isOriginalTemplate: true };

  // Attempt 2: any existing per-color SKU for this product (re-run scenario).
  // Marked _isOriginalTemplate=false so we DON'T delete it afterwards.
  const fallback = await client.query(
    `SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.internal_sku,
            s.variant_name, s.sell_by, s.variant_type, s.is_sample, s.status,
            pr.cost, pr.retail_price, pr.price_basis,
            pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
            pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet,
            pk.weight_per_pallet_lbs
       FROM skus s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN pricing pr ON pr.sku_id = s.id
       LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.vendor_id = $1
        AND (s.vendor_sku LIKE $2 || '-%'
             OR s.internal_sku LIKE 'FUJIWA-' || $2 || '-%')
      LIMIT 1`,
    [FUJIWA_VENDOR_ID, safeCode]
  );
  if (fallback.rows[0]) return { ...fallback.rows[0], _isOriginalTemplate: false };
  return null;
}

async function getSkuAttributes(client, skuId) {
  const res = await client.query(
    `SELECT attribute_id, value FROM sku_attributes WHERE sku_id = $1`,
    [skuId]
  );
  return res.rows;
}

async function upsertColorSku(client, { productId, template, newVendorSku, colorName, size, imageUrl, baseAttrs }) {
  const internalSku = 'FUJIWA-' + newVendorSku;
  // variant_name holds the SIZE (e.g. "6\" x 6\"") so it appears correctly in
  // the storefront title. The Color attribute differentiates SKUs within a size.
  const variantName = size;

  // Upsert the SKU (insert or update by internal_sku)
  const upserted = await client.query(
    `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, is_sample, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (internal_sku) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         vendor_sku = EXCLUDED.vendor_sku,
         variant_name = EXCLUDED.variant_name,
         sell_by = EXCLUDED.sell_by,
         variant_type = EXCLUDED.variant_type,
         status = EXCLUDED.status,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
    [productId, newVendorSku, internalSku, variantName, template.sell_by, template.variant_type, template.is_sample, template.status]
  );
  const newSkuId = upserted.rows[0].id;

  // Copy pricing
  if (template.cost != null || template.retail_price != null) {
    await client.query(
      `INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sku_id) DO UPDATE SET
           cost = EXCLUDED.cost,
           retail_price = EXCLUDED.retail_price,
           price_basis = EXCLUDED.price_basis`,
      [newSkuId, template.cost, template.retail_price, template.price_basis]
    );
  }

  // Copy packaging
  if (template.sqft_per_box != null || template.pieces_per_box != null) {
    await client.query(
      `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (sku_id) DO UPDATE SET
           sqft_per_box = EXCLUDED.sqft_per_box,
           pieces_per_box = EXCLUDED.pieces_per_box,
           weight_per_box_lbs = EXCLUDED.weight_per_box_lbs,
           freight_class = EXCLUDED.freight_class,
           boxes_per_pallet = EXCLUDED.boxes_per_pallet,
           sqft_per_pallet = EXCLUDED.sqft_per_pallet,
           weight_per_pallet_lbs = EXCLUDED.weight_per_pallet_lbs`,
      [newSkuId, template.sqft_per_box, template.pieces_per_box, template.weight_per_box_lbs,
       template.freight_class, template.boxes_per_pallet, template.sqft_per_pallet, template.weight_per_pallet_lbs]
    );
  }

  // Delete then re-insert attributes (wipes stale color; keeps material/brand)
  // Normalise size for the Size attribute value (e.g. '6" x 6"' → '6x6')
  const normSize = size
    .replace(/"/g, '')
    .replace(/\s*x\s*/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();

  await client.query(`DELETE FROM sku_attributes WHERE sku_id = $1`, [newSkuId]);
  for (const attr of baseAttrs) {
    // Skip Color (we set the real one below) and Size (we override with correct value)
    if (attr.attribute_id === ATTR_COLOR) continue;
    if (attr.attribute_id === ATTR_SIZE) continue;
    await client.query(
      `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
         ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
      [newSkuId, attr.attribute_id, attr.value]
    );
  }
  // Write the real color
  await client.query(
    `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
    [newSkuId, ATTR_COLOR, colorName]
  );
  // Write the correct size for this entry
  await client.query(
    `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
    [newSkuId, ATTR_SIZE, normSize]
  );

  // Replace primary media for this SKU with the per-color swatch image
  if (imageUrl) {
    await client.query(
      `DELETE FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary'`,
      [newSkuId]
    );
    await client.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1, $2, 'primary', $3, $3, 0)`,
      [productId, newSkuId, imageUrl]
    );
  }

  return newSkuId;
}

// Delete any OLD SKUs for this (product, size) whose vendor_sku is the legacy
// pre-colour template (e.g. plain "BOHOL", "JOYA-1x1"). Also removes cascaded
// pricing/packaging/attributes. Only runs if we've actually inserted at least
// one new per-colour SKU for this size.
async function removeLegacyTemplate(client, templateSkuId, keepSkuIds) {
  if (keepSkuIds.includes(templateSkuId)) return 0;
  // Clean related rows first (FK constraints)
  await client.query(`DELETE FROM sku_attributes  WHERE sku_id = $1`, [templateSkuId]);
  await client.query(`DELETE FROM pricing         WHERE sku_id = $1`, [templateSkuId]);
  await client.query(`DELETE FROM packaging       WHERE sku_id = $1`, [templateSkuId]);
  await client.query(`DELETE FROM media_assets    WHERE sku_id = $1`, [templateSkuId]);
  await client.query(`DELETE FROM inventory_snapshots WHERE sku_id = $1`, [templateSkuId]);
  // NB: cart_items / order_items / quote_items may reference it; skip those.
  try {
    await client.query(`DELETE FROM skus WHERE id = $1`, [templateSkuId]);
    return 1;
  } catch (e) {
    console.log('    [KEEP LEGACY] ' + templateSkuId + ' — ' + e.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const filter = process.argv.slice(2);
  const codes = filter.length > 0
    ? filter.map(c => c.toUpperCase()).filter(c => SERIES_MAP[c] || SERIES_MAP[c.replace('_', '/')])
    : Object.keys(SERIES_MAP);

  if (codes.length === 0) {
    console.error('No matching series codes. Valid: ' + Object.keys(SERIES_MAP).join(', '));
    process.exit(1);
  }

  console.log('Processing ' + codes.length + ' series: ' + codes.join(', ') + '\n');

  const client = new Client({
    host: process.env.PG_HOST || process.env.DB_HOST || 'db',
    port: +(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DATABASE || 'flooring_pim',
  });
  await client.connect();

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  let totalNew = 0, totalRemoved = 0, totalSkipped = 0;

  try {
    for (const code of codes) {
      const entries = SERIES_MAP[code];
      console.log('[' + code + ']');

      for (const { slug, size, dbPrefix } of entries) {
        console.log('  ' + slug + '  (' + size + ')');

        const template = await findTemplateSku(client, dbPrefix || code, size);
        if (!template) {
          console.log('    [NO TEMPLATE SKU] skipping — check SERIES_MAP size matches DB');
          totalSkipped++;
          continue;
        }

        const variations = await scrapeSeries(page, slug);
        if (!variations.length) {
          console.log('    [NO VARIATIONS] page had no variations_form data');
          totalSkipped++;
          continue;
        }
        console.log('    Found ' + variations.length + ' colour(s)');

        const baseAttrs = await getSkuAttributes(client, template.sku_id);
        const seriesBaseSlug = slugToBase(slug);

        // Detect whether all variations share a single v.sku (Fujiwa bug for
        // Penny Round et al). If so, we must synthesise unique vendor_skus
        // from pa_colors.
        const distinctSkuValues = new Set(variations.map(v => v.sku));
        const skusCollide = distinctSkuValues.size < variations.length;

        await client.query('BEGIN');
        try {
          const newSkuIds = [];
          for (const v of variations) {
            const colorName = extractColorName(v.pa_colors, seriesBaseSlug, code);
            if (!colorName) {
              console.log('      [SKIP] ' + v.sku + ' — couldn\'t parse color from "' + v.pa_colors + '"');
              continue;
            }
            let vendorSku = v.sku;
            if (skusCollide) {
              const derived = deriveVendorSkuFromPaColors(v.pa_colors, code);
              if (derived) vendorSku = derived;
            }
            const newSkuId = await upsertColorSku(client, {
              productId: template.product_id,
              template,
              newVendorSku: vendorSku,
              colorName,
              size,
              imageUrl: v.image_url,
              baseAttrs,
            });
            newSkuIds.push(newSkuId);
            console.log('      + ' + vendorSku + ' → "' + colorName + '"' + (v.image_url ? '  [img]' : ''));
            totalNew++;
          }

          // Drop the legacy template SKU only if it's the original single-size
          // template (not a fallback re-run reference to an existing color SKU)
          if (newSkuIds.length > 0 && template._isOriginalTemplate) {
            const removed = await removeLegacyTemplate(client, template.sku_id, newSkuIds);
            totalRemoved += removed;
            if (removed > 0) {
              console.log('      - legacy ' + template.vendor_sku + ' removed');
            }
          }

          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          console.error('    [ROLLBACK] ' + e.message);
          console.error(e.stack);
        }
      }
      console.log('');
    }
  } finally {
    await browser.close();
    await client.end();
  }

  console.log('=== Summary ===');
  console.log('New/updated colour SKUs: ' + totalNew);
  console.log('Legacy template SKUs removed: ' + totalRemoved);
  console.log('Series pages skipped: ' + totalSkipped);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
