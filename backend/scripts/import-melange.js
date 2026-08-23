#!/usr/bin/env node

/**
 * Import Mélange Boutique Tile product data from the 2026 Price Book.
 *
 * 26 collections, ~120 products (one per color), ~440 SKUs:
 *   Porcelain Floor Tile: Block, Ca'Foscari, Caprice, Concrete Soul Infinity,
 *     Decoro, Factory, Kauri, Moonlit, Nirvana, Portland Stone,
 *     Real Stone Travertino, Shellstone, Sicily, Sixty 60 Silktech, Snow,
 *     Stonetalk, Sublime, Sunstone, Tele di Marmo, Unique Bourgogne,
 *     Unique Infinity, Woodbreak
 *   Wall Tile: Evolution, Memory, Pearl
 *   Porcelain Paver: Quartz Outdoor
 *
 * Pricing: PDF lists dealer cost. Imported (non-domestic) items carry the 2026
 * book's 5% surcharge in cost; retail = cost × 1.6 keystone snapped to a 9-ending
 * with the covering floor (cost+$0.99), matching the store standard. Domestic
 * (Made-in-USA) collections — Shellstone, Quartz Outdoor (`domestic: true`) — are
 * surcharge-exempt. All tiles sold per sqft unless noted (mosaico sheets SH,
 * bullnose PC → per-unit accessories).
 *
 * Newly priced/activated in the 2026 book: Shellstone (USA) and Unique Bourgogne
 * (Italy) — both were placeholder drafts; the placeholder SKUs/products (old IDs
 * 4400s / 4450s) are pruned and their photos migrated to the real color products.
 * Still draft (absent from the 2026 book): Sicily, Caprice, Evolution.
 *
 * Re-run-safe: retail is only recomputed when a SKU is new or its cost changed
 * (e.g. first surcharge run) — unchanged rows keep the platform 9-ending backfill.
 *
 * Usage: docker compose exec api node scripts/import-melange.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const RETAIL_MARKUP = 1.6;
const RETAIL_MIN_MARGIN = 0.99;
// 2026 price book: "A surcharge of 5% will be applied to all items with the
// exception of domestic products." Domestic = Made in USA (Shellstone, Quartz
// Outdoor). We bake the surcharge into Roma's COST for imported items, so retail
// (cost x1.6 keystone, 9-ending) carries it through. See collection `domestic` flag.
const IMPORT_SURCHARGE = 1.05;
const round2 = (v) => Math.round(Number(v) * 100) / 100;

// ---- Pricing (mirrors scrapers/base.js upsertPricing 9-ending + covering floor) ----
const keystone = (cost) => Number(cost) * RETAIL_MARKUP;
const nearestNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
};
// price_basis 'per_sqft' → covering floor (cost+$0.99) applies; 'per_unit'
// (mosaico sheets, bullnose pieces) → 9-ending only.
const priceRetail = (cost, basis) => {
  const rn = keystone(cost);
  if (!(rn > 0)) return null;
  const cn = basis === 'per_sqft' ? (Number(cost) || 0) : 0;
  const floorMin = cn > 0 ? cn + RETAIL_MIN_MARGIN : 0;
  let nine = nearestNine(Math.max(rn, floorMin));
  if (floorMin > 0 && nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
};

// ==================== Helpers ====================

async function upsertProduct(vendor_id, { name, collection, category_id, description_short }) {
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short)
    VALUES ($1, $2, $3, $4, 'active', $5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendor_id, name, collection || '', category_id || null, description_short || null]);
  return result.rows[0];
}

async function upsertSku(product_id, { vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label }) {
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = COALESCE(EXCLUDED.sell_by, skus.sell_by),
      variant_type = COALESCE(EXCLUDED.variant_type, skus.variant_type),
      accessory_label = COALESCE(EXCLUDED.accessory_label, skus.accessory_label),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'box', variant_type || null, accessory_label || null]);
  return result.rows[0];
}

async function upsertPricing(sku_id, { cost, retail_price, price_basis }) {
  // Cost-gated retail: only (re)write retail when the row is new, its cost
  // changed (e.g. the 5% surcharge bumps imported costs), or it has no retail
  // yet. This preserves the platform-wide 9-ending backfill on unchanged rows
  // (re-deriving from cost would nudge nickel-history ties by a cent). Never
  // overwrites a retail_locked (Home-Depot-matched) price.
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = CASE
        WHEN COALESCE(pricing.retail_locked, false) THEN pricing.retail_price
        WHEN pricing.retail_price IS NULL
             OR pricing.cost IS DISTINCT FROM EXCLUDED.cost THEN EXCLUDED.retail_price
        ELSE pricing.retail_price
      END,
      price_basis = EXCLUDED.price_basis
  `, [sku_id, cost, retail_price, price_basis || 'per_sqft']);
}

async function upsertPackaging(sku_id, pkg) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet)
  `, [sku_id, pkg.sqft_per_box || null, pkg.pieces_per_box || null, pkg.boxes_per_pallet || null, pkg.sqft_per_pallet || null]);
}

async function setAttr(sku_id, slug, value) {
  if (!value) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
}

// Delete SKUs and all their child rows (no ON DELETE CASCADE on most FKs).
// Media should be migrated off BEFORE calling this (rows with sku_id set here
// are removed). Placeholders are draft/never-ordered, so cart/order refs are none.
async function deleteSkus(skuIds) {
  if (!skuIds.length) return;
  for (const tbl of ['media_assets', 'pricing', 'packaging', 'sku_attributes', 'inventory_snapshots']) {
    await pool.query(`DELETE FROM ${tbl} WHERE sku_id = ANY($1::uuid[])`, [skuIds]);
  }
  await pool.query('DELETE FROM sku_accessories WHERE parent_sku_id = ANY($1::uuid[]) OR accessory_sku_id = ANY($1::uuid[])', [skuIds]);
  await pool.query('DELETE FROM skus WHERE id = ANY($1::uuid[])', [skuIds]);
}

// Promote a placeholder SKU's photos to product level (sku_id → NULL) on the
// target product, so the newly-activated color keeps its imagery. Only the
// chosen donor SKU is promoted (the product-level unique index forbids dupes);
// callers delete the remaining placeholder SKUs (and their media) afterwards.
async function promoteMediaToProduct(donorSkuId, targetProductId) {
  await pool.query(
    'UPDATE media_assets SET sku_id = NULL, product_id = $2 WHERE sku_id = $1',
    [donorSkuId, targetProductId]
  );
}

// Priced items the 2026 book marks "Special Order" — imported so they carry
// pricing, but set to draft (not shown in-stock on the storefront). Unpriced
// non-stock pavers aren't imported at all. Drafted LAST, after the generic
// active/draft pass (which would otherwise flip them back to active).
const SPECIAL_ORDER_SKUS = [
  // Concrete Soul Infinity — Natural finish (Wax is the stock finish)
  'MLG-CSI-4169-3', 'MLG-CSI-4170-3', 'MLG-CSI-4171-3', 'MLG-CSI-4172-3', 'MLG-CSI-4173-3',
  // Sixty 60 Silktech — Salvia/Cielo 24x48 (Natural + Timbro)
  'MLG-S60-4178-2', 'MLG-S60-4179-2', 'MLG-S60-4178-3', 'MLG-S60-4179-3',
  // Sublime — Lap Polished 24x48, Strutt 48x48, Lap Polished 48x48
  'MLG-SUB-4195-4', 'MLG-SUB-4196-4', 'MLG-SUB-4197-4',
  'MLG-SUB-4195-6', 'MLG-SUB-4196-6', 'MLG-SUB-4197-6',
  'MLG-SUB-4195-7', 'MLG-SUB-4196-7', 'MLG-SUB-4197-7',
  // Unique Bourgogne — Variee Lappato Antique
  'MLG-UBG-4361-6', 'MLG-UBG-4362-6', 'MLG-UBG-4363-6',
  // Unique Infinity — Cobblestone 48x48, Puerstone 48x48
  'MLG-UNI-4259-3', 'MLG-UNI-4260-3', 'MLG-UNI-4261-3', 'MLG-UNI-4262-3',
  'MLG-UNI-4259-6', 'MLG-UNI-4260-6', 'MLG-UNI-4261-6', 'MLG-UNI-4262-6',
];

// ==================== Collection Data ====================
// Each collection: { name, code, desc, origin, material, groups: [{ finish?, size, price, um, pkg, colors }] }
// code: 3-letter prefix for internal_sku to avoid vendor_sku collisions across collections

const COLLECTIONS = [
  // ── 1. BLOCK ──────────────────────────────────────────
  {
    name: 'Block', code: 'BLK',
    desc: 'Full Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '30x30', price: 4.79, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 2, boxes_per_pallet: 42, sqft_per_pallet: 508.62 },
        colors: [['Cinder','3015-2'],['Iron','3016-2'],['Nickel','3017-2'],['Mist','3018-2']] },
      { size: '24x48', price: 4.95, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 35 },
        colors: [['Mist','3018-5']] },
      { size: '48x48', price: 5.95, um: 'SF',
        pkg: { sqft_per_box: 30.99, pieces_per_box: 2, boxes_per_pallet: 20 },
        colors: [['Mist','3018-4']] },
      { size: '30x60', price: 5.59, um: 'SF',
        pkg: { sqft_per_box: 24.22, pieces_per_box: 2, boxes_per_pallet: 18, sqft_per_pallet: 435.96 },
        colors: [['Cinder','3015-3'],['Iron','3016-3'],['Nickel','3017-3'],['Mist','3018-3']] },
    ],
  },

  // ── 2. CA'FOSCARI ─────────────────────────────────────
  {
    name: "Ca'Foscari", code: 'CAF',
    desc: 'Porcelain Tile Floor | Wall',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '8x48', price: 4.39, um: 'SF',
        pkg: { sqft_per_box: 10.33, pieces_per_box: 4, boxes_per_pallet: 48, sqft_per_pallet: 495.84 },
        colors: [['Lino','3033-2'],['Canapa','3034-2'],['Avana','3035-2'],['Tabacco','3036-2'],['Moro','3037-2']] },
    ],
  },

  // ── 3. CONCRETE SOUL INFINITY ─────────────────────────
  {
    name: 'Concrete Soul Infinity', code: 'CSI',
    desc: 'Color Body Porcelain Tile Rectified',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Wax', size: '32x32', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 13.89, pieces_per_box: 2, boxes_per_pallet: 44, sqft_per_pallet: 611.16 },
        colors: [['Ivory','4169-2'],['Sand','4170-2'],['Moka','4171-2'],['Concrete','4172-2'],['Antra','4173-2']] },
      { finish: 'Natural', size: '32x32', price: 4.69, um: 'SF',
        pkg: { sqft_per_box: 13.89, pieces_per_box: 2, boxes_per_pallet: 44, sqft_per_pallet: 611.16 },
        colors: [['Ivory','4169-3'],['Sand','4170-3'],['Moka','4171-3'],['Concrete','4172-3'],['Antra','4173-3']] },
    ],
  },

  // ── 4. DECORO ─────────────────────────────────────────
  {
    name: 'Decoro', code: 'DEC',
    desc: 'Porcelain Tile Floor | Wall | Interior',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '10x10', price: 5.59, um: 'SF',
        pkg: { sqft_per_box: 13.45, pieces_per_box: 20, boxes_per_pallet: 54 },
        colors: [
          ['Mediterranea #1','3099-2'],['Mediterranea #2','3100-2'],['Mediterranea #3','3101-2'],
          ['Mediterranea #4','3102-2'],['Mediterranea #5','3103-2'],
          ['Marble & Wood #1','3104-2'],['Marble & Wood #2','3105-2'],['Marble & Wood #3','3106-2'],
          ['Marble & Wood #4','3107-2'],['Marble & Wood #5','3108-2'],
        ] },
    ],
  },

  // ── 5. FACTORY ────────────────────────────────────────
  {
    name: 'Factory', code: 'FAC',
    desc: 'Porcelain Tile Floor | Wall | Full Body Commercial',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '15x30', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 4, boxes_per_pallet: 48, sqft_per_pallet: 581.28 },
        colors: [['Beige','3073-2'],['Dark Grey','3074-2'],['Grey','3075-2'],['White','3076-2']] },
      { finish: 'Carpet', size: '15x30', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 4, boxes_per_pallet: 48, sqft_per_pallet: 581.28 },
        colors: [['Beige','3073-3'],['Dark Grey','3074-3'],['Grey','3075-3'],['White','3076-3']] },
      { finish: 'Mix', size: '15x30', price: 4.89, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 12, boxes_per_pallet: 36, sqft_per_pallet: 435.96 },
        colors: [['Beige','3073-4'],['Dark Grey','3074-4'],['Grey','3075-4'],['White','3076-4']] },
      { size: '30x30', price: 4.79, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 2, boxes_per_pallet: 45, sqft_per_pallet: 544.95 },
        colors: [['Beige','3073-5'],['Dark Grey','3074-5'],['Grey','3075-5'],['White','3076-5']] },
      { size: '48x48', price: 5.79, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 1, boxes_per_pallet: 36 },
        colors: [['White','3076-6']] },
    ],
  },

  // ── 6. KAURI ──────────────────────────────────────────
  {
    name: 'Kauri', code: 'KAU',
    desc: 'Porcelain Tile Floor | Wall | Polished | Matt',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Polished', size: '8x48', price: 5.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 6, boxes_per_pallet: 24, sqft_per_pallet: 372.00 },
        colors: [['Tasman','2753-2'],['Fiordland','2754-2'],['Awanui','2823-22'],['Victoria','2755-2'],['Nelson','3212-2']] },
      { finish: 'Matt', size: '8x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 6, boxes_per_pallet: 24, sqft_per_pallet: 372.00 },
        colors: [['Tasman','2753-3'],['Fiordland','2754-3'],['Awanui','2823-33'],['Victoria','2755-3'],['Nelson','3212-3']] },
      { finish: 'Tech Polished', size: '24x48', price: 6.75, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 30 },
        colors: [['Tasman','2753-4'],['Fiordland','2754-4'],['Awanui','2823-44'],['Victoria','2755-4']] },
    ],
  },

  // ── 7. MOONLIT ────────────────────────────────────────
  {
    name: 'Moonlit', code: 'MNL',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Natural Rectified', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 35, sqft_per_pallet: 542.5 },
        colors: [['White','4320-2'],['Sand','4321-2'],['Pearl','4322-2'],['Greige','4323-2']] },
      { finish: 'Natural Rectified', size: '48x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 30.99, pieces_per_box: 2, boxes_per_pallet: 20, sqft_per_pallet: 619.8 },
        colors: [['White','4320-3'],['Sand','4321-3'],['Pearl','4322-3'],['Greige','4323-3']] },
      { finish: 'Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['White','4320-5'],['Sand','4321-5'],['Pearl','4322-5'],['Greige','4323-5']] },
      { finish: 'Grid Decor', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['White','4320-4'],['Sand','4321-4'],['Pearl','4322-4'],['Greige','4323-4']] },
    ],
  },

  // ── 8. NIRVANA ────────────────────────────────────────
  {
    name: 'Nirvana', code: 'NRV',
    desc: 'Porcelain Tile Floor | Wall',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '8x48', price: 4.39, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 6, boxes_per_pallet: 32, sqft_per_pallet: 496.0 },
        colors: [['Beige','3060-2'],['Bianco','3061-2'],['Grigio','3062-2'],['Noir','3063-2']] },
    ],
  },

  // ── 9. PORTLAND STONE ─────────────────────────────────
  {
    name: 'Portland Stone', code: 'PLS',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Vein Cut Natural', size: '12x24', price: 3.99, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 40, sqft_per_pallet: 465.20 },
        colors: [['Sand','4235-2'],['Talc','4236-2'],['Ash','4237-2'],['Lead','4238-2'],['Antheracite','4239-2']] },
      { finish: 'Vein Cut Natural', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Sand','4235-3'],['Talc','4236-3'],['Ash','4237-3'],['Lead','4238-3'],['Antheracite','4239-3']] },
      { finish: 'Vein Cut Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Sand','4235-8'],['Talc','4236-8'],['Ash','4237-8'],['Lead','4238-8'],['Antheracite','4239-8']] },
      { finish: 'Vein Cut Bocciardato', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Sand','4235-4'],['Talc','4236-4'],['Ash','4237-4']] },
      { finish: 'Decoro Lines', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Sand','4235-5'],['Talc','4236-5'],['Ash','4237-5'],['Lead','4238-5'],['Antheracite','4239-5']] },
      { finish: 'Cross Cut Natural', size: '24x24', price: 4.46, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 3, boxes_per_pallet: 40, sqft_per_pallet: 465.20 },
        colors: [['Sand','4235-6'],['Talc','4236-6'],['Ash','4237-6'],['Lead','4238-6'],['Antheracite','4239-6']] },
      { finish: 'Cross Cut Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Sand','4235-7'],['Talc','4236-7'],['Ash','4237-7'],['Lead','4238-7'],['Antheracite','4239-7']] },
    ],
  },

  // ── 10. REAL STONE TRAVERTINO ─────────────────────────
  {
    name: 'Real Stone Travertino', code: 'RST',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R9',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Cross Cut', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Bianco','4285-2'],['Beige','4286-2'],['Noce','4287-2']] },
      { finish: 'Cross Cut', size: '48x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 1, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Bianco','4285-3'],['Beige','4286-3'],['Noce','4287-3']] },
      { finish: 'Cross Cut Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Bianco','4285-7'],['Beige','4286-7'],['Noce','4287-7']] },
      { finish: 'Vein Cut', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Bianco','4285-4'],['Beige','4286-4'],['Noce','4287-4'],['Titanio','4288-4']] },
      { finish: 'Vein Cut Mosaico', size: '2x2', price: 13.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Bianco','4285-8'],['Beige','4286-8'],['Noce','4287-8'],['Titanio','4288-8']] },
      { finish: 'Struttura 3D Vein', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2 },
        colors: [['Bianco','4285-5'],['Beige','4286-5'],['Noce','4287-5'],['Titanio','4288-5']] },
      { finish: 'Struttura 3D Cross', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Bianco','4285-6'],['Beige','4286-6'],['Noce','4287-6']] },
    ],
  },

  // ── 11. SIXTY 60 SILKTECH ─────────────────────────────
  {
    name: 'Sixty 60 Silktech', code: 'S60',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      // Field tiles
      { finish: 'Natural Rectified', size: '12x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 48, sqft_per_pallet: 558.24 },
        colors: [['Antracite','4175-4'],['Cenere','4176-4'],['Talco','4177-4'],['Salvia','4178-4'],['Cielo','4179-4']] },
      { finish: 'Timbro', size: '12x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 48, sqft_per_pallet: 558.24 },
        colors: [['Antracite','4175-5'],['Cenere','4176-5'],['Talco','4177-5'],['Salvia','4178-5'],['Cielo','4179-5']] },
      { finish: 'Natural Rectified', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Antracite','4175-2'],['Cenere','4176-2'],['Talco','4177-2'],['Salvia','4178-2'],['Cielo','4179-2']] },
      { finish: 'Timbro', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Antracite','4175-3'],['Cenere','4176-3'],['Talco','4177-3'],['Salvia','4178-3'],['Cielo','4179-3']] },
      // Hex
      { finish: 'Hex Silktech', size: '8x7', price: 4.49, um: 'SF',
        pkg: { sqft_per_box: 4.94, pieces_per_box: 16, boxes_per_pallet: 100, sqft_per_pallet: 494.0 },
        colors: [['Nero','4174-6'],['Cenere','4176-6'],['Talco','4177-6'],['Salvia','4178-6'],['Cielo','4179-6']] },
      { finish: 'Hex Timbro', size: '8x7', price: 4.71, um: 'SF',
        pkg: { sqft_per_box: 4.94, pieces_per_box: 16, boxes_per_pallet: 100, sqft_per_pallet: 494.0 },
        colors: [['Nero','4174-7'],['Cenere','4176-7'],['Talco','4177-7'],['Salvia','4178-7'],['Cielo','4179-7']] },
      // Minibrick
      { finish: 'Minibrick Matt', size: '2x6', price: 4.94, um: 'SF',
        pkg: { sqft_per_box: 8.72, pieces_per_box: 108, boxes_per_pallet: 64, sqft_per_pallet: 558.08 },
        colors: [['Nero','4174-8'],['Cenere','4176-8'],['Talco','4177-8'],['Salvia','4178-8'],['Cielo','4179-8']] },
      { finish: 'Minibrick Lux', size: '2x6', price: 5.39, um: 'SF',
        pkg: { sqft_per_box: 8.72, pieces_per_box: 108, boxes_per_pallet: 64, sqft_per_pallet: 558.08 },
        colors: [['Nero','4174-10'],['Cenere','4176-10'],['Talco','4177-10'],['Salvia','4178-10'],['Cielo','4179-10']] },
      { finish: 'Minibrick Timbro', size: '2x6', price: 5.14, um: 'SF',
        pkg: { sqft_per_box: 8.72, pieces_per_box: 108, boxes_per_pallet: 64, sqft_per_pallet: 558.08 },
        colors: [['Nero','4174-9'],['Cenere','4176-9'],['Talco','4177-9'],['Salvia','4178-9'],['Cielo','4179-9']] },
      // Bullnose (accessory)
      { finish: 'Bullnose Matt', size: '2x6', price: 5.90, um: 'PC',
        pkg: { pieces_per_box: 15 },
        colors: [['Nero','4174-11'],['Cenere','4176-11'],['Talco','4177-11'],['Salvia','4178-11'],['Cielo','4179-11']] },
      { finish: 'Bullnose Lux', size: '2x6', price: 6.20, um: 'PC',
        pkg: { pieces_per_box: 15 },
        colors: [['Nero','4174-12'],['Cenere','4176-12'],['Talco','4177-12'],['Salvia','4178-12'],['Cielo','4179-12']] },
    ],
  },

  // ── 12. SNOW ──────────────────────────────────────────
  {
    name: 'Snow', code: 'SNW',
    desc: 'Full Body Porcelain Tile Rectified',
    origin: 'Spain', material: 'Porcelain',
    groups: [
      { finish: 'Natural', size: '36x36', price: 4.69, um: 'SF',
        pkg: { sqft_per_box: 8.72, pieces_per_box: 1, boxes_per_pallet: 40, sqft_per_pallet: 348.8 },
        colors: [['White','3198-2']] },
      { finish: 'Lap Polished', size: '36x36', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 8.72, pieces_per_box: 1, boxes_per_pallet: 40, sqft_per_pallet: 348.8 },
        colors: [['White','3198-3']] },
      { finish: 'Lap Polished', size: '24x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.55, pieces_per_box: 3, boxes_per_pallet: 40 },
        colors: [['White','3198-4']] },
    ],
  },

  // ── 13. STONETALK ─────────────────────────────────────
  {
    name: 'Stonetalk', code: 'STK',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      // Minimal Natural Rectified
      { finish: 'Minimal Natural', size: '12x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 40, sqft_per_pallet: 465.20 },
        colors: [['White','3121-2'],['Grey','3122-2'],['Dark','3123-2'],['Sand','3125-2'],['Taupe','3126-2']] },
      { finish: 'Minimal Natural', size: '24x24', price: 4.46, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 3, boxes_per_pallet: 40, sqft_per_pallet: 465.20 },
        colors: [['White','3121-3'],['Grey','3122-3'],['Dark','3123-3'],['Sand','3125-3'],['Taupe','3126-3']] },
      { finish: 'Minimal Natural', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['White','3121-4'],['Grey','3122-4'],['Dark','3123-4'],['Sand','3125-4'],['Taupe','3126-4']] },
      // 36x36 Minimal Natural (…-8) dropped from the 2026 book — the existing
      // SKUs are set to draft in the placeholder-cleanup step below.
      { finish: 'Mosaico Dado', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['White','3121-5'],['Grey','3122-5'],['Dark','3123-5'],['Sand','3125-5'],['Taupe','3126-5']] },
      { finish: 'Bullnose', size: '3x24', price: 10.20, um: 'PC',
        pkg: { pieces_per_box: 15 },
        colors: [['White','3121-6'],['Grey','3122-6'],['Dark','3123-6'],['Sand','3125-6'],['Taupe','3126-6']] },
      // Martellata Natural Rectified
      { finish: 'Martellata Natural', size: '12x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 40, sqft_per_pallet: 465.20 },
        colors: [['White','3127-2'],['Grey','3128-2'],['Dark','3129-2'],['Sand','3131-2'],['Taupe','3132-2']] },
      { finish: 'Martellata Natural', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['White','3127-4'],['Grey','3128-4'],['Dark','3129-4'],['Sand','3131-4'],['Taupe','3132-4']] },
      // Rullata Natural Rectified
      { finish: 'Rullata Natural', size: '12x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 40, sqft_per_pallet: 465.20 },
        colors: [['White','3133-2'],['Grey','3134-2'],['Dark','3135-2'],['Sand','3137-2'],['Taupe','3138-2']] },
      { finish: 'Rullata Natural', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['White','3133-4'],['Grey','3134-4'],['Dark','3135-4'],['Sand','3137-4'],['Taupe','3138-4']] },
    ],
  },

  // ── 14. SUBLIME ───────────────────────────────────────
  {
    name: 'Sublime', code: 'SUB',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Minimal Natural', size: '24x48', price: 4.95, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 35, sqft_per_pallet: 542.5 },
        colors: [['Ivory','4195-2'],['Grey','4196-2'],['Beige','4197-2']] },
      { finish: 'Strutt Natural', size: '24x48', price: 4.95, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 35, sqft_per_pallet: 542.5 },
        colors: [['Ivory','4195-3'],['Grey','4196-3'],['Beige','4197-3']] },
      { finish: 'Lap Polished', size: '24x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 35, sqft_per_pallet: 542.5 },
        colors: [['Ivory','4195-4'],['Grey','4196-4'],['Beige','4197-4']] },
      { finish: 'Minimal Natural', size: '48x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 30.99, pieces_per_box: 2, boxes_per_pallet: 20 },
        colors: [['Ivory','4195-5'],['Grey','4196-5'],['Beige','4197-5']] },
      { finish: 'Strutt Natural', size: '48x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 30.99, pieces_per_box: 2, boxes_per_pallet: 20 },
        colors: [['Ivory','4195-6'],['Grey','4196-6'],['Beige','4197-6']] },
      { finish: 'Lap Polished', size: '48x48', price: 5.99, um: 'SF',
        pkg: { sqft_per_box: 30.99, pieces_per_box: 2, boxes_per_pallet: 20 },
        colors: [['Ivory','4195-7'],['Grey','4196-7'],['Beige','4197-7']] },
      { finish: 'Mosaico Dado', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Ivory','4195-8'],['Grey','4196-8'],['Beige','4197-8']] },
    ],
  },

  // ── 15. SUNSTONE ──────────────────────────────────────
  {
    name: 'Sunstone', code: 'SUN',
    desc: 'Color Body Porcelain Tile',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '12x24', price: 3.69, um: 'SF',
        pkg: { sqft_per_box: 13.99, pieces_per_box: 7, boxes_per_pallet: 40, sqft_per_pallet: 490.80 },
        colors: [['Baugi','3198-2'],['Freya','3199-2'],['Alof','3200-2'],['Loki','3201-2'],['Groa','3202-2'],['Norne','3203-2']] },
      { size: '24x48', price: 4.79, um: 'SF',
        pkg: { sqft_per_box: 15.93, pieces_per_box: 2, boxes_per_pallet: 35, sqft_per_pallet: 557.55 },
        colors: [['Baugi','3198-3'],['Freya','3199-3'],['Alof','3200-3'],['Loki','3201-3'],['Groa','3202-3'],['Norne','3203-3']] },
      { finish: 'Paver TH2.0', size: '24x24', price: 5.99, um: 'SF',
        pkg: {},
        colors: [['Freya','3199-5'],['Loki','3201-5'],['Groa','3202-5']] },
      { finish: 'Paver TH2.0', size: '24x48', price: 6.79, um: 'SF',
        pkg: {},
        colors: [['Freya','3199-6'],['Loki','3201-6'],['Groa','3202-6']] },
    ],
  },

  // ── 16. TELE DI MARMO ─────────────────────────────────
  {
    name: 'Tele di Marmo', code: 'TDM',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Natural', size: '12x24', price: 4.19, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 48 },
        colors: [['Arabescato Corochia','4188-2'],['Nero Marquina','4187-2'],['White Paradise','4189-2']] },
      { finish: 'Polished', size: '12x24', price: 5.39, um: 'SF',
        pkg: { sqft_per_box: 11.63, pieces_per_box: 6, boxes_per_pallet: 48 },
        colors: [['Arabescato Corochia','4188-3'],['Nero Marquina','4187-3'],['White Paradise','4189-3']] },
      { finish: 'Polished', size: '24x48', price: 5.89, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36 },
        colors: [['Arabescato Corochia','4188-7'],['Nero Marquina','4187-7'],['White Paradise','4189-7']] },
      { finish: 'Mosaic Matt', size: '2x2', price: 13.99, um: 'SH',
        pkg: { pieces_per_box: 5 },
        colors: [['Arabescato Corochia','3188-4'],['Nero Marquina','4187-4'],['White Paradise','4189-4']] },
      { finish: 'Intrecci Mosaic Polished', size: '1x2', price: 17.89, um: 'SH',
        pkg: { pieces_per_box: 5 },
        colors: [['Arabescato Corochia','3188-5'],['Nero Marquina','4187-5'],['White Paradise','4189-5']] },
    ],
  },

  // ── 17. UNIQUE INFINITY ───────────────────────────────
  {
    name: 'Unique Infinity', code: 'UNI',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      // Cobblestone Armonia
      { finish: 'Cobblestone', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Beige','4259-2'],['White','4260-2'],['Grey','4261-2'],['Black','4262-2']] },
      { finish: 'Cobblestone', size: '48x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Beige','4259-3'],['White','4260-3'],['Grey','4261-3'],['Black','4262-3']] },
      { finish: 'Cobblestone Mosaico', size: '2x2', price: 13.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Beige','4259-4'],['White','4260-4'],['Grey','4261-4'],['Black','4262-4']] },
      // Puerstone Harmony
      { finish: 'Puerstone', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Beige','4259-5'],['White','4260-5'],['Grey','4261-5'],['Black','4262-5']] },
      { finish: 'Puerstone', size: '48x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Beige','4259-6'],['White','4260-6'],['Grey','4261-6'],['Black','4262-6']] },
      { finish: 'Puerstone Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Beige','4259-7'],['White','4260-7'],['Grey','4261-7'],['Black','4262-7']] },
      // Arcade Decoro
      { finish: 'Arcade Decoro', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558.0 },
        colors: [['Beige','4259-8'],['White','4260-8'],['Grey','4261-8'],['Black','4262-8']] },
    ],
  },

  // ── 18. WOODBREAK ─────────────────────────────────────
  {
    name: 'Woodbreak', code: 'WDB',
    desc: 'Rectified Color Body Porcelain Tile Floor | Wall',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { size: '8x48', price: 4.39, um: 'SF',
        pkg: { sqft_per_box: 10.44, pieces_per_box: 4, boxes_per_pallet: 48, sqft_per_pallet: 501.12 },
        colors: [['Cherry','3220-2'],['Ebony','3219-2'],['Hemlock','3218-2'],['Larch','3215-2'],['Mahogany','3216-2'],['Oak','3217-2']] },
      { size: '8x64', price: 5.29, um: 'SF',
        pkg: { sqft_per_box: 13.78, pieces_per_box: 4, boxes_per_pallet: 36 },
        colors: [['Ebony','3219-3'],['Hemlock','3218-3'],['Larch','3215-3'],['Oak','3217-3']] },
    ],
  },

  // ── 19. MEMORY (Wall Tile) ────────────────────────────
  {
    name: 'Memory', code: 'MEM',
    desc: 'Ceramic Wall Tile',
    origin: null, material: 'Ceramic',
    wallTile: true,
    groups: [
      { size: '10x30', price: 3.99, um: 'SF',
        pkg: { sqft_per_box: 16.14, pieces_per_box: 8, boxes_per_pallet: 36 },
        colors: [['Gris','2658'],['Blanco','2657'],['Cream','2788']] },
      // Decore accessories
      { finish: 'Decore', size: '10x30', price: 4.99, um: 'SF', accessory: true,
        pkg: { sqft_per_box: 16.14, pieces_per_box: 8, boxes_per_pallet: 36 },
        colors: [['Blanco','2656'],['Gris','2655'],['Cream','2809']] },
      // Bullnose accessories
      { finish: 'Surface Bullnose', size: '2x10', price: 4.35, um: 'PC', accessory: true,
        pkg: {},
        colors: [['Gris','2658-3'],['Blanco','2657-3']] },
    ],
  },

  // ── 20. PEARL (Wall Tile) ─────────────────────────────
  {
    name: 'Pearl', code: 'PRL',
    desc: 'White Body Ceramic Tile',
    origin: 'Spain', material: 'Ceramic',
    wallTile: true,
    groups: [
      { size: '12x36', price: 4.75, um: 'SF',
        pkg: { sqft_per_box: 12.27, pieces_per_box: 4, boxes_per_pallet: 48, sqft_per_pallet: 588.96 },
        colors: [['White','3195-2'],['Grey','3196-2'],['Copper','3197-2']] },
      { finish: 'Drop', size: '12x36', price: 5.39, um: 'SF',
        pkg: { sqft_per_box: 12.27, pieces_per_box: 4, boxes_per_pallet: 48, sqft_per_pallet: 588.96 },
        colors: [['White','3195-3'],['Grey','3196-3'],['Copper','3197-3']] },
    ],
  },

  // ── 21. QUARTZ OUTDOOR (Paver) ────────────────────────
  {
    name: 'Quartz Outdoor', code: 'QOD',
    desc: 'Rectified Color Body Porcelain Paver 20mm',
    origin: 'USA', material: 'Porcelain', domestic: true,
    paver: true,
    groups: [
      { size: '12x48', price: 5.59, um: 'SF',
        pkg: { sqft_per_box: 16, pieces_per_box: 4, boxes_per_pallet: 16, sqft_per_pallet: 256 },
        colors: [['White','3209-2'],['Extra White','3210-2'],['Grey','3211-2']] },
      { size: '24x24', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 8, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 288 },
        colors: [['White','3209-3'],['Extra White','3210-3'],['Grey','3211-3']] },
      { size: '24x48', price: 5.79, um: 'SF',
        pkg: { sqft_per_box: 16, pieces_per_box: 2, boxes_per_pallet: 16, sqft_per_pallet: 256 },
        colors: [['White','3209-4'],['Extra White','3210-4'],['Grey','3211-4']] },
    ],
  },

  // ── 22. SHELLSTONE (2026 book p.16 — Made in USA, DOMESTIC, no surcharge) ──
  {
    name: 'Shellstone', code: 'SHL',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'USA', material: 'Porcelain', domestic: true,
    groups: [
      { finish: 'Natural', size: '12x24', price: 3.99, um: 'SF',
        pkg: { sqft_per_box: 17.0, pieces_per_box: 9, boxes_per_pallet: 32, sqft_per_pallet: 544 },
        colors: [['White','4345-2'],['Gray','4346-2'],['Dark Gray','4347-2'],['Sand','4348-2']] },
      { finish: 'Natural', size: '24x48', price: 4.79, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558 },
        colors: [['White','4345-3'],['Gray','4346-3'],['Dark Gray','4347-3'],['Sand','4348-3']] },
      { finish: 'Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['White','4345-4'],['Gray','4346-4'],['Dark Gray','4347-4'],['Sand','4348-4']] },
      { finish: 'Décor Groove', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558 },
        colors: [['White','4345-5'],['Gray','4346-5'],['Dark Gray','4347-5'],['Sand','4348-5']] },
    ],
  },

  // ── 23. SICILY (draft — not in price list) ──────────
  {
    name: 'Sicily', code: 'SCL',
    desc: 'Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    draft: true, price: 0,
    groups: [
      { size: '15x30', price: 0, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 4, boxes_per_pallet: 48 },
        colors: [['Beige','4410'],['Dark Gray','4411'],['Gray','4412'],['White','4413']] },
      { size: '30x30', price: 0, um: 'SF',
        pkg: { sqft_per_box: 12.11, pieces_per_box: 12, boxes_per_pallet: 42 },
        colors: [['Beige','4410-2'],['Dark Gray','4411-2'],['Gray','4412-2'],['White','4413-2']] },
      { size: '24x48', price: 0, um: 'SF',
        pkg: { sqft_per_box: 15.50, pieces_per_box: 2, boxes_per_pallet: 35 },
        colors: [['Beige','4410-3'],['Dark Gray','4411-3'],['Gray','4412-3'],['White','4413-3']] },
    ],
  },

  // ── 24. CAPRICE (draft — not in price list) ─────────
  {
    name: 'Caprice', code: 'CPR',
    desc: 'Porcelain Tile Floor | Wall | Interior R9 Decorative',
    origin: 'Spain', material: 'Porcelain',
    draft: true, price: 0,
    groups: [
      { size: '8x8', price: 0, um: 'SF',
        pkg: { sqft_per_box: 10.76, pieces_per_box: 25 },
        colors: [
          ['Chatelet','4420'],['Block','4421'],['Balance','4422'],['Burgundy','4423'],
          ['Cloth','4424'],['Compass','4425'],['Liberty Taupe','4426'],['Liberty White','4427'],
          ['Loire','4428'],['Patchwork','4429'],['Saint-Tropez','4430'],
        ] },
    ],
  },

  // ── 25. EVOLUTION (draft — not in price list) ───────
  {
    name: 'Evolution', code: 'EVO',
    desc: 'Ceramic Wall Tile + Trim Accessories',
    origin: null, material: 'Ceramic',
    wallTile: true, draft: true, price: 0,
    groups: [
      { size: '4x16', price: 0, um: 'SF',
        pkg: { sqft_per_box: 10.76, pieces_per_box: 25 },
        colors: [['Blanco Brillo','4440'],['Gris Oscuro Brillo','4441']] },
      { finish: 'Bullnose', size: '1x16', price: 0, um: 'PC', accessory: true,
        pkg: { pieces_per_box: 15 },
        colors: [['Blanco Brillo','4440-2'],['Gris Oscuro Brillo','4441-2']] },
      { finish: 'Quarter Round', size: '1x8', price: 0, um: 'PC', accessory: true,
        pkg: { pieces_per_box: 20 },
        colors: [['Blanco Brillo','4440-3'],['Gris Oscuro Brillo','4441-3']] },
      { finish: 'Torello Liner', size: '1x8', price: 0, um: 'PC', accessory: true,
        pkg: { pieces_per_box: 20 },
        colors: [['Blanco Brillo','4440-4'],['Gris Oscuro Brillo','4441-4']] },
    ],
  },

  // ── 26. UNIQUE BOURGOGNE (2026 book p.28 — Made in Italy, imported) ──
  {
    name: 'Unique Bourgogne', code: 'UBG',
    desc: 'Full Color Body Porcelain Tile Floor | Wall | Interior | Exterior R10',
    origin: 'Italy', material: 'Porcelain',
    groups: [
      { finish: 'Minimal Naturale', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558 },
        colors: [['Blanc','4361-2'],['Beige','4362-2'],['Gris','4363-2']] },
      { finish: 'Minimal Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Blanc','4361-3'],['Beige','4362-3'],['Gris','4363-3']] },
      { finish: 'Variee Naturale', size: '24x48', price: 4.99, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558 },
        colors: [['Blanc','4361-4'],['Beige','4362-4'],['Gris','4363-4']] },
      { finish: 'Variee Mosaico', size: '2x2', price: 14.99, um: 'SH',
        pkg: { sqft_per_box: 5, pieces_per_box: 5 },
        colors: [['Blanc','4361-5'],['Beige','4362-5'],['Gris','4363-5']] },
      { finish: 'Variee Lappato Antique', size: '24x48', price: 5.49, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558 },
        colors: [['Blanc','4361-6'],['Beige','4362-6'],['Gris','4363-6']] },
      { finish: 'Pointes Naturale Décor', size: '24x48', price: 5.29, um: 'SF',
        pkg: { sqft_per_box: 15.5, pieces_per_box: 2, boxes_per_pallet: 36, sqft_per_pallet: 558 },
        colors: [['Blanc','4361-7'],['Beige','4362-7'],['Gris','4363-7']] },
    ],
  },
];

// ==================== Main ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MLG'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Melange Boutique Tile', 'MLG', 'https://www.melangetile.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Melange Boutique Tile (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Melange Boutique Tile (${vendorId})`);
  }

  // Look up category IDs
  const catRes = await pool.query("SELECT id, slug FROM categories WHERE slug IN ('porcelain-tile', 'ceramic-tile', 'porcelain-paver')");
  const catMap = {};
  for (const row of catRes.rows) catMap[row.slug] = row.id;

  const CAT_PORCELAIN = catMap['porcelain-tile'] || null;
  const CAT_CERAMIC = catMap['ceramic-tile'] || null;
  const CAT_PAVER = catMap['porcelain-paver'] || null;

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;

  // Track new product IDs so we can distinguish them from old collection-level ones
  const newProductIds = new Set();

  for (const coll of COLLECTIONS) {
    // Determine category
    let catId = CAT_PORCELAIN;
    if (coll.wallTile) catId = CAT_CERAMIC || CAT_PORCELAIN;
    if (coll.paver) catId = CAT_PAVER || CAT_PORCELAIN;

    // Gather all unique colors across all groups in this collection
    const colorMap = new Map(); // color name → [{ group, vendorSku }]
    for (const group of coll.groups) {
      for (const [color, vendorSku] of group.colors) {
        if (!colorMap.has(color)) colorMap.set(color, []);
        colorMap.get(color).push({ group, vendorSku });
      }
    }

    let collSkus = 0;

    // One product per color
    for (const [color, entries] of colorMap) {
      const prod = await upsertProduct(vendorId, {
        name: color,
        collection: coll.name,
        category_id: catId,
        description_short: `${coll.name} – ${color}`,
      });
      if (prod.is_new) productsCreated++; else productsUpdated++;
      newProductIds.add(prod.id);

      for (const { group, vendorSku } of entries) {
        const sellBy = group.um === 'SF' ? 'sqft' : 'unit';
        const priceBasis = group.um === 'SF' ? 'per_sqft' : 'per_unit';
        const isAccessory = group.um === 'PC' || group.um === 'SH' || group.accessory;
        const variantType = isAccessory ? 'accessory' : null;

        const finish = group.finish;
        const variantName = finish
          ? `${color}, ${group.size}, ${finish}`
          : `${color}, ${group.size}`;

        const internalSku = `MLG-${coll.code}-${vendorSku}`;

        const sku = await upsertSku(prod.id, {
          vendor_sku: vendorSku,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: sellBy,
          variant_type: variantType,
          // Accessories (bullnose PC, mosaico SH) show accessory_label in the
          // storefront's Matching Accessories card. Use the full variant name so
          // sibling accessories stay distinguishable (e.g. Bullnose Lux vs Matt),
          // matching the rest of the Melange catalog. Non-accessories: null.
          accessory_label: isAccessory ? variantName : null,
        });
        if (sku.is_new) skusCreated++; else skusUpdated++;

        // Pricing: PDF price = dealer cost. Imported (non-domestic) items carry
        // the 5% surcharge in cost; retail = cost × 1.6 keystone, 9-ending.
        // Skip pricing for draft collections (not in price list yet).
        if (!coll.draft && group.price > 0) {
          const cost = coll.domestic ? round2(group.price) : round2(group.price * IMPORT_SURCHARGE);
          const retail = priceRetail(cost, priceBasis);
          await upsertPricing(sku.id, { cost, retail_price: retail, price_basis: priceBasis });
        }

        // Packaging
        if (group.pkg && (group.pkg.sqft_per_box || group.pkg.pieces_per_box)) {
          await upsertPackaging(sku.id, group.pkg);
        }

        // Attributes
        await setAttr(sku.id, 'color', color);
        await setAttr(sku.id, 'size', group.size);
        if (finish) await setAttr(sku.id, 'finish', finish);
        await setAttr(sku.id, 'material', coll.material || 'Porcelain');
        if (coll.origin) await setAttr(sku.id, 'country_of_origin', coll.origin);

        collSkus++;
      }
    }

    console.log(`  ${coll.name} — ${colorMap.size} colors, ${collSkus} SKUs`);
  }

  console.log(`\nProducts: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs: ${skusCreated} created, ${skusUpdated} updated`);

  // ==================== Placeholder pruning (2026 activations) ====================
  // Shellstone & Unique Bourgogne were placeholder drafts with fake IDs. The real
  // 2026 SKUs are now imported; drop the stale ones, keeping one photo set/color.
  console.log('\n--- Cleanup: pruning placeholder SKUs & migrating photos ---');

  // Shellstone: real import reused the same-named products; remove old SKUs 4400-4403(+-2).
  for (const [color, baseId] of [['White', '4400'], ['Gray', '4401'], ['Dark Gray', '4402'], ['Sand', '4403']]) {
    const ph = await pool.query(`
      SELECT s.id, s.vendor_sku, s.product_id FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection = 'Shellstone' AND p.name = $2
        AND s.internal_sku LIKE 'MLG-SHL-44%'`, [vendorId, color]);
    if (!ph.rows.length) continue;
    const donor = ph.rows.find(r => r.vendor_sku === baseId) || ph.rows[0];
    await promoteMediaToProduct(donor.id, donor.product_id);
    await deleteSkus(ph.rows.map(r => r.id));
    console.log(`  Shellstone/${color}: promoted photos, removed ${ph.rows.length} placeholder SKUs`);
  }

  // Unique Bourgogne: old 6-color products (…Variee/…Minimal) → new Blanc/Beige/Gris.
  const UBG_MAP = [
    { newColor: 'Blanc', placeholders: ['Blanc Variee', 'Blanc Minimal'], donorBaseId: '4450' },
    { newColor: 'Beige', placeholders: ['Beige Variee', 'Beige Minimal'], donorBaseId: '4452' },
    { newColor: 'Gris', placeholders: ['Gris Variee', 'Gris Minimal'], donorBaseId: '4454' },
  ];
  for (const { newColor, placeholders, donorBaseId } of UBG_MAP) {
    const newProd = await pool.query(
      `SELECT id FROM products WHERE vendor_id = $1 AND collection = 'Unique Bourgogne' AND name = $2`,
      [vendorId, newColor]);
    const newProdId = newProd.rows[0]?.id;
    const ph = await pool.query(`
      SELECT s.id, s.vendor_sku, s.product_id FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection = 'Unique Bourgogne' AND p.name = ANY($2)`,
      [vendorId, placeholders]);
    if (!ph.rows.length) continue;
    const donor = ph.rows.find(r => r.vendor_sku === donorBaseId) || ph.rows[0];
    if (newProdId) await promoteMediaToProduct(donor.id, newProdId);
    await deleteSkus(ph.rows.map(r => r.id));
    const phProdIds = [...new Set(ph.rows.map(r => r.product_id))];
    await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1::uuid[])', [phProdIds]);
    await pool.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [phProdIds]);
    console.log(`  Unique Bourgogne/${newColor}: promoted photos, removed ${ph.rows.length} placeholder SKUs + ${phProdIds.length} products`);
  }

  // ==================== Cleanup ====================
  // Migrate media from old collection-level products to new color-level products,
  // then delete old empty products.

  console.log('\n--- Cleanup: migrating media & removing old products ---');

  // Find old Melange products that are NOT in our new set (collection-level leftovers)
  const oldProdsRes = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.id = $1 AND p.id != ALL($2::uuid[])
  `, [vendorId, Array.from(newProductIds)]);

  const oldProducts = oldProdsRes.rows;
  console.log(`Found ${oldProducts.length} old collection-level product(s) to clean up`);

  for (const oldProd of oldProducts) {
    // Find media assets on the old product
    const mediaRes = await pool.query(
      'SELECT id, url, original_url, asset_type, sort_order FROM media_assets WHERE product_id = $1 AND sku_id IS NULL',
      [oldProd.id]
    );

    if (mediaRes.rows.length > 0) {
      // Find all new products in the same collection to receive these images
      const newProdsInColl = await pool.query(`
        SELECT id FROM products
        WHERE vendor_id = $1 AND collection = $2 AND id = ANY($3::uuid[])
      `, [vendorId, oldProd.collection, Array.from(newProductIds)]);

      let copied = 0;
      for (const newProd of newProdsInColl.rows) {
        for (const asset of mediaRes.rows) {
          await pool.query(`
            INSERT INTO media_assets (product_id, url, original_url, asset_type, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO NOTHING
          `, [newProd.id, asset.url, asset.original_url, asset.asset_type, asset.sort_order]);
          copied++;
        }
      }
      console.log(`  Copied ${copied} media refs from "${oldProd.name}" (${oldProd.collection}) → ${newProdsInColl.rows.length} new products`);

      // Delete old media assets
      await pool.query('DELETE FROM media_assets WHERE product_id = $1', [oldProd.id]);
    }

    // Check if old product still has SKUs (shouldn't, since upsert moved them)
    const skuCheck = await pool.query('SELECT COUNT(*) FROM skus WHERE product_id = $1', [oldProd.id]);
    if (parseInt(skuCheck.rows[0].count) === 0) {
      await pool.query('DELETE FROM products WHERE id = $1', [oldProd.id]);
      console.log(`  Deleted empty product: "${oldProd.name}" (${oldProd.collection})`);
    } else {
      console.log(`  WARN: "${oldProd.name}" still has ${skuCheck.rows[0].count} SKUs — skipping delete`);
    }
  }

  // Collect product IDs from draft collections
  const draftCollections = new Set(COLLECTIONS.filter(c => c.draft).map(c => c.name));
  const draftProductIds = new Set();
  const activeProductIds = new Set();

  for (const id of newProductIds) {
    // Look up which collection this product belongs to
    const res = await pool.query('SELECT collection FROM products WHERE id = $1', [id]);
    if (res.rows.length && draftCollections.has(res.rows[0].collection)) {
      draftProductIds.add(id);
    } else {
      activeProductIds.add(id);
    }
  }

  // Set active status on non-draft products
  if (activeProductIds.size > 0) {
    await pool.query(`
      UPDATE products SET status = 'active'
      WHERE vendor_id = $1 AND id = ANY($2::uuid[]) AND status != 'active'
    `, [vendorId, Array.from(activeProductIds)]);

    await pool.query(`
      UPDATE skus SET status = 'active'
      WHERE product_id = ANY($1::uuid[]) AND status != 'active'
    `, [Array.from(activeProductIds)]);
  }

  // Set draft status on draft products
  if (draftProductIds.size > 0) {
    await pool.query(`
      UPDATE products SET status = 'draft'
      WHERE vendor_id = $1 AND id = ANY($2::uuid[]) AND status != 'draft'
    `, [vendorId, Array.from(draftProductIds)]);

    await pool.query(`
      UPDATE skus SET status = 'draft'
      WHERE product_id = ANY($1::uuid[]) AND status != 'draft'
    `, [Array.from(draftProductIds)]);

    console.log(`  Set ${draftProductIds.size} draft products (${draftCollections.size} collections)`);
  }

  // Stonetalk 36x36 Minimal Natural (…-8) dropped from the 2026 book → discontinue.
  // Runs LAST: the generic active/draft pass above flips every SKU of an active
  // collection back to 'active', so this discontinuation must come after it.
  const stk = await pool.query(`
    UPDATE skus s SET status = 'draft', updated_at = CURRENT_TIMESTAMP
    FROM products p
    WHERE s.product_id = p.id AND p.vendor_id = $1 AND p.collection = 'Stonetalk'
      AND s.internal_sku IN ('MLG-STK-3121-8','MLG-STK-3122-8','MLG-STK-3123-8','MLG-STK-3125-8','MLG-STK-3126-8')
      AND s.status <> 'draft'
    RETURNING s.id`, [vendorId]);
  console.log(`  Stonetalk 36x36: set ${stk.rowCount} SKUs to draft (dropped from 2026 book)`);

  // Special-order items → draft (priced, but not shown as in-stock).
  const so = await pool.query(`
    UPDATE skus s SET status = 'draft', updated_at = CURRENT_TIMESTAMP
    FROM products p
    WHERE s.product_id = p.id AND p.vendor_id = $1
      AND s.internal_sku = ANY($2) AND s.status <> 'draft'
    RETURNING s.id`, [vendorId, SPECIAL_ORDER_SKUS]);
  console.log(`  Special order: set ${so.rowCount} SKUs to draft`);

  console.log('\n=== Melange Import Complete ===');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
