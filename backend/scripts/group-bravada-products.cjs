#!/usr/bin/env node
/**
 * Group Bravada products: reorganize 832-imported SKUs into the website's
 * 6-collection structure and set proper collection names.
 *
 * The 832 import creates products with collection = "Bravada" and name = TRN
 * value (e.g., "Contempo", "D'Vine", etc.). This script ensures:
 *
 *   1. One product per collection (Contempo, D'Vine, Symphony, Barcelona, Branché, Regalia)
 *   2. All color SKUs merged under the correct collection product
 *   3. Accessories grouped and marked correctly
 *   4. Collection names prefixed with "Bravada" for vendor filtering
 *
 * Before: Bravada > Contempo Ambry (1 SKU), Bravada > Contempo Carolean (1 SKU), ...
 * After:  Bravada Contempo (14 SKUs) — colors as variant_name on each SKU
 *
 * Usage:
 *   node backend/scripts/group-bravada-products.cjs --dry-run
 *   node backend/scripts/group-bravada-products.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const dryRun = process.argv.includes('--dry-run');

// ── Website collection definitions ──────────────────────────────────────────
// Maps 832 TRN/collection names to the website's canonical collection names.
// The 832 may have slightly different naming (case, accents, etc.)
const COLLECTION_MAP = {
  'contempo':   { canonical: 'Bravada Contempo',   species: 'European White Oak' },
  "d'vine":     { canonical: "Bravada D'Vine",     species: 'French White Oak' },
  'dvine':      { canonical: "Bravada D'Vine",     species: 'French White Oak' },
  'd vine':     { canonical: "Bravada D'Vine",     species: 'French White Oak' },
  'symphony':   { canonical: 'Bravada Symphony',   species: 'French White Oak' },
  'barcelona':  { canonical: 'Bravada Barcelona',  species: 'European Walnut' },
  'branche':    { canonical: 'Bravada Branché',    species: 'French White Oak' },
  'branché':    { canonical: 'Bravada Branché',    species: 'French White Oak' },
  'regalia':    { canonical: 'Bravada Regalia',    species: 'European Oak' },
};

// SKU prefix → collection mapping (backup when TRN is ambiguous)
const SKU_PREFIX_MAP = {
  'CN':   'Bravada Contempo',     // CNAM001, CNCA003, CNLU004...
  'BCEW': 'Bravada Barcelona',    // BCEW001, BCEWHB001...
  'RGLA': 'Bravada Regalia',      // RGLA001, RGLA002...
};

// Accessory detection pattern
const ACCESSORY_PATTERN = /stairnose|t-mold|reducer|threshold|end.?cap|quarter.?round|flush.?mount|overlap|molding|transition/i;

function detectCollection(product, sku) {
  // 1. Try from product name or collection
  const pName = (product.name || '').toLowerCase().trim();
  const pColl = (product.collection || '').replace(/^bravada\s*/i, '').toLowerCase().trim();

  for (const [key, val] of Object.entries(COLLECTION_MAP)) {
    if (pName.includes(key) || pColl.includes(key) || pName === key || pColl === key) {
      return val.canonical;
    }
  }

  // 2. Try from vendor_sku prefix
  const vendorSku = (sku || '').toUpperCase();
  for (const [prefix, coll] of Object.entries(SKU_PREFIX_MAP)) {
    if (vendorSku.startsWith(prefix)) return coll;
  }

  // 3. Fallback: keep as-is with Bravada prefix
  if (pColl && pColl.length > 2) {
    return `Bravada ${pColl.charAt(0).toUpperCase() + pColl.slice(1)}`;
  }

  return null;
}

function makeSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  console.log(`\n=== Group Bravada Products ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // Find Tri-West vendor (Bravada is a brand under Tri-West)
  const { rows: vendors } = await pool.query(
    `SELECT id, name FROM vendors WHERE name ILIKE '%tri%west%' OR code = 'TW' LIMIT 1`
  );
  if (vendors.length === 0) { console.error('No Tri-West vendor found'); process.exit(1); }
  const vendor = vendors[0];
  console.log(`Vendor: ${vendor.name} (${vendor.id})\n`);

  // Load all Bravada products and their SKUs
  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id, p.description_short, p.description_long,
           p.display_name, p.slug, p.status
    FROM products p
    WHERE p.vendor_id = $1
      AND (p.collection ILIKE 'Bravada%' OR p.name ILIKE 'Bravada%'
           OR p.collection ILIKE '%Contempo%' OR p.collection ILIKE '%Symphony%'
           OR p.collection ILIKE '%Barcelona%' OR p.collection ILIKE '%Regalia%'
           OR p.collection ILIKE '%Branche%' OR p.collection ILIKE '%Branché%'
           OR p.collection ILIKE '%D''Vine%' OR p.collection ILIKE '%DVine%')
    ORDER BY p.collection, p.name
  `, [vendor.id]);

  console.log(`Found ${products.length} Bravada products\n`);
  if (products.length === 0) {
    console.log('No Bravada products found — run import-triwest-832.cjs first');
    await pool.end();
    return;
  }

  // Load all SKUs for these products
  const productIds = products.map(p => p.id);
  const { rows: allSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name,
           s.variant_type, s.sell_by, s.product_id
    FROM skus s
    WHERE s.product_id = ANY($1)
    ORDER BY s.variant_name
  `, [productIds]);

  console.log(`Found ${allSkus.length} SKUs across these products\n`);

  // Build product-to-SKUs lookup
  const skusByProduct = new Map();
  for (const sku of allSkus) {
    if (!skusByProduct.has(sku.product_id)) skusByProduct.set(sku.product_id, []);
    skusByProduct.get(sku.product_id).push(sku);
  }

  // ── Phase 1: Classify products by target collection ──
  console.log('--- Phase 1: Classify by collection ---\n');

  // Map: targetCollection → [{ product, skus, isAccessory }]
  const collectionGroups = new Map();

  for (const product of products) {
    const skus = skusByProduct.get(product.id) || [];
    const firstSku = skus[0]?.vendor_sku || '';

    // Detect if this is an accessory product
    const isAccessory = ACCESSORY_PATTERN.test(product.name)
      || skus.some(s => s.variant_type === 'accessory')
      || skus.some(s => ACCESSORY_PATTERN.test(s.variant_name || ''));

    // Detect target collection
    let target = detectCollection(product, firstSku);
    if (!target) {
      console.log(`  UNKNOWN: "${product.collection}" / "${product.name}" (${skus.length} SKUs)`);
      continue;
    }

    // Accessories go to a separate group key
    const groupKey = isAccessory ? `${target} Accessories` : target;

    if (!collectionGroups.has(groupKey)) collectionGroups.set(groupKey, []);
    collectionGroups.get(groupKey).push({ product, skus, isAccessory });

    console.log(`  ${product.collection} / ${product.name} (${skus.length} SKUs) → ${groupKey}${isAccessory ? ' [accessory]' : ''}`);
  }

  // ── Phase 2: Merge products within each collection ──
  console.log('\n--- Phase 2: Merge into one product per collection ---\n');

  let totalSkusMoved = 0;
  let totalMediaMoved = 0;
  let totalProductsDeleted = 0;

  for (const [groupKey, entries] of collectionGroups) {
    if (entries.length <= 1) {
      const e = entries[0];
      console.log(`${groupKey}: 1 product, ${e.skus.length} SKUs — already grouped`);
      // Just rename if needed
      if (e.product.collection !== groupKey && !dryRun) {
        await pool.query(
          `UPDATE products SET collection = $1, slug = $2 WHERE id = $3`,
          [groupKey, makeSlug(groupKey), e.product.id]
        );
        console.log(`  Renamed collection: "${e.product.collection}" → "${groupKey}"`);
      }
      continue;
    }

    // Pick master: product with most SKUs, or first alphabetically
    entries.sort((a, b) => b.skus.length - a.skus.length || a.product.name.localeCompare(b.product.name));
    const master = entries[0];
    const others = entries.slice(1);

    const totalSkus = entries.reduce((sum, e) => sum + e.skus.length, 0);
    console.log(`${groupKey}: ${entries.length} products → 1 product (${totalSkus} SKUs)`);
    console.log(`  Master: "${master.product.name}" (${master.skus.length} SKUs)`);

    if (dryRun) {
      for (const o of others) {
        console.log(`    merge ← "${o.product.name}" (${o.skus.length} SKUs)`);
      }
      continue;
    }

    // Move SKUs and media from others to master
    for (const other of others) {
      // Move SKUs
      const { rowCount: skusMoved } = await pool.query(
        `UPDATE skus SET product_id = $1 WHERE product_id = $2`,
        [master.product.id, other.product.id]
      );

      // Move SKU-level media
      const { rowCount: skuMedia } = await pool.query(
        `UPDATE media_assets SET product_id = $1 WHERE product_id = $2 AND sku_id IS NOT NULL`,
        [master.product.id, other.product.id]
      );

      // Move product-level media with sort_order offset
      let prodMedia = 0;
      for (const atype of ['primary', 'alternate', 'lifestyle', 'spec_pdf', 'swatch']) {
        const { rows: [{ max_sort }] } = await pool.query(`
          SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM media_assets
          WHERE product_id = $1 AND asset_type = $2 AND sku_id IS NULL
        `, [master.product.id, atype]);

        const { rowCount } = await pool.query(`
          UPDATE media_assets SET product_id = $1, sort_order = sort_order + $3
          WHERE product_id = $2 AND asset_type = $4 AND sku_id IS NULL
        `, [master.product.id, other.product.id, parseInt(max_sort) + 1, atype]);
        prodMedia += rowCount;
      }

      totalSkusMoved += skusMoved;
      totalMediaMoved += skuMedia + prodMedia;
      console.log(`    ← "${other.product.name}": ${skusMoved} SKUs, ${skuMedia + prodMedia} media`);
    }

    // Delete orphaned products
    const deleteIds = others.map(o => o.product.id);
    const { rowCount: deleted } = await pool.query(
      `DELETE FROM products WHERE id = ANY($1)`, [deleteIds]
    );
    totalProductsDeleted += deleted;

    // Update master product metadata
    await pool.query(`
      UPDATE products
      SET collection = $1,
          name = $2,
          slug = $3,
          status = 'active',
          updated_at = NOW()
      WHERE id = $4
    `, [groupKey, groupKey.replace(/^Bravada\s+/, ''), makeSlug(groupKey), master.product.id]);
  }

  // ── Summary ──
  console.log(`\n=== Summary ===`);
  console.log(`Collection groups: ${collectionGroups.size}`);
  console.log(`SKUs moved: ${totalSkusMoved}`);
  console.log(`Media moved: ${totalMediaMoved}`);
  console.log(`Products deleted: ${totalProductsDeleted}`);

  // Final counts
  const { rows: [final] } = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as products, COUNT(s.id) as skus,
           COUNT(DISTINCT p.collection) as collections
    FROM products p
    LEFT JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.collection ILIKE 'Bravada%'
  `, [vendor.id]);
  console.log(`\nFinal: ${final.products} products, ${final.skus} SKUs, ${final.collections} collections`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
