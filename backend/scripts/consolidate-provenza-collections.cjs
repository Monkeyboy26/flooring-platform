#!/usr/bin/env node
/**
 * Consolidate Provenza Collection Fragments
 *
 * The triwest-catalog.js scraper previously created fragmented collection names
 * like "Uptown Chic Wpf 7.15 X60" instead of the canonical "Uptown Chic".
 * This script merges orphan products into their canonical counterparts.
 *
 * Actions per merge:
 *   1. Move orphan's SKUs to canonical product
 *   2. Move orphan's media_assets (skip duplicates)
 *   3. Update cart_items FK
 *   4. Update 'collection' sku_attribute to canonical name
 *   5. Deactivate orphan product (don't delete — safety)
 *
 * If a canonical product doesn't exist yet, one is created.
 *
 * Usage:
 *   node backend/scripts/consolidate-provenza-collections.cjs --dry-run   # Preview
 *   node backend/scripts/consolidate-provenza-collections.cjs              # Execute
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440008'; // Tri-West

/** Canonical collection name map (uppercase key → display name) */
const COLLECTION_MAP = {
  'AFFINITY': 'Affinity',
  'AFRICAN PLAINS': 'African Plains',
  'ANTICO': 'Antico',
  'CADEAU': 'Cadeau',
  'CONCORDE OAK': 'Concorde Oak',
  'DUTCH MASTERS': 'Dutch Masters',
  'EUROPEAN OAK 4MM': 'Dutch Masters',
  'FIRST IMPRESSIONS': 'First Impressions',
  'GRAND POMPEII': 'Grand Pompeii',
  'HERRINGBONE RESERVE': 'Herringbone Reserve',
  'HERRINGBONE CUSTOM': 'Herringbone Custom',
  'LIGHTHOUSE COVE': 'Lighthouse Cove',
  'LUGANO': 'Lugano',
  'MATEUS': 'Mateus',
  'MODA LIVING': 'Moda Living',
  'MODA LIVING ELITE': 'Moda Living Elite',
  'MODERN RUSTIC': 'Modern Rustic',
  'MODESSA': 'Modessa',
  'NEW WAVE': 'New Wave',
  'NEW YORK LOFT': 'New York Loft',
  'NYC LOFT': 'New York Loft',
  'OLD WORLD': 'Old World',
  'OPIA': 'Opia',
  'PALAIS ROYALE': 'Palais Royale',
  'POMPEII': 'Pompeii',
  'RICHMOND': 'Richmond',
  'STONESCAPE': 'Stonescape',
  'STUDIO MODERNO': 'Studio Moderno',
  'TRESOR': 'Tresor',
  'UPTOWN CHIC': 'Uptown Chic',
  'VITALI ELITE': 'Vitali Elite',
  'VITALI': 'Vitali',
  'VOLTERRA': 'Volterra',
  'WALL CHIC': 'Wall Chic',
};

/** Sorted canonical keys longest-first for starts-with fallback */
const CANONICAL_KEYS = Object.keys(COLLECTION_MAP).sort((a, b) => b.length - a.length);

/**
 * Try to map a collection name to a canonical Provenza collection.
 * Strips product-type suffixes, size dimensions, and looks up in COLLECTION_MAP.
 * Returns { canonical, displayCollection } or null if no match.
 */
function resolveCanonical(collectionName) {
  // Strip "Provenza - " prefix if present
  let raw = collectionName.replace(/^Provenza\s*-\s*/i, '').trim();

  let normalized = raw.toUpperCase();
  // Strip known product-type suffixes
  normalized = normalized
    .replace(/\b(WPF-LVP|WPF|SPC-LVP|SPC|MAXCORE|LVP|LAMINATE|COLLECTION|COLL)\b/g, '')
    .trim();
  // Strip size dimensions: "20MIL", "8MMX7.16", "7.15 X60", "9 X72", etc.
  normalized = normalized
    .replace(/\b\d+MIL\b/g, '')
    .replace(/\b\d+MM?X[\d.]+\b/g, '')
    .replace(/\b[\d.]+\s*X\s*[\d.]+\b/g, '')
    .trim();
  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Direct lookup
  if (COLLECTION_MAP[normalized]) {
    return {
      canonical: COLLECTION_MAP[normalized],
      displayCollection: `Provenza - ${COLLECTION_MAP[normalized]}`,
    };
  }
  // Starts-with fallback (longest match first)
  for (const key of CANONICAL_KEYS) {
    if (normalized.startsWith(key)) {
      return {
        canonical: COLLECTION_MAP[key],
        displayCollection: `Provenza - ${COLLECTION_MAP[key]}`,
      };
    }
  }
  return null;
}

async function main() {
  const client = await pool.connect();
  console.log(`\n=== Provenza Collection Consolidation (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  try {
    await client.query('BEGIN');

    // ─── Get 'collection' attribute ID ─────────────────────────────────
    const attrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'collection'`);
    const collectionAttrId = attrRes.rows.length ? attrRes.rows[0].id : null;

    // ─── Load all active Provenza products ──────────────────────────────
    const productsRes = await client.query(`
      SELECT p.id, p.name, p.collection, p.display_name, p.category_id,
        (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id) AS sku_count
      FROM products p
      WHERE p.vendor_id = $1
        AND p.status = 'active'
        AND (p.collection LIKE 'Provenza%' OR p.collection LIKE 'provenza%')
      ORDER BY p.collection
    `, [VENDOR_ID]);

    const allProducts = productsRes.rows;
    console.log(`Found ${allProducts.length} active Provenza products\n`);

    // Build set of canonical collection names that exist in the map
    const canonicalCollections = new Set(
      Object.values(COLLECTION_MAP).map(n => `Provenza - ${n}`)
    );

    // Separate into canonical vs orphan
    const canonicalProducts = {}; // displayCollection → product row
    const orphanProducts = [];

    for (const p of allProducts) {
      if (canonicalCollections.has(p.collection)) {
        // If multiple products share the same canonical collection, pick the one with most SKUs
        if (!canonicalProducts[p.collection] ||
            parseInt(p.sku_count) > parseInt(canonicalProducts[p.collection].sku_count)) {
          canonicalProducts[p.collection] = p;
        }
      } else {
        orphanProducts.push(p);
      }
    }

    console.log(`Canonical products: ${Object.keys(canonicalProducts).length}`);
    console.log(`Orphan products: ${orphanProducts.length}\n`);

    // ─── Process orphans ───────────────────────────────────────────────
    let merged = 0;
    let skusMoved = 0;
    let mediaMoved = 0;
    let cartItemsUpdated = 0;
    let attrsUpdated = 0;
    let productsCreated = 0;
    let unmatched = 0;
    const unmatchedNames = [];
    const mergeLog = {}; // canonical name → count of SKUs merged

    for (const orphan of orphanProducts) {
      const match = resolveCanonical(orphan.collection);
      if (!match) {
        unmatched++;
        unmatchedNames.push(orphan.collection);
        continue;
      }

      const { displayCollection } = match;

      // Find or create the canonical product
      let target = canonicalProducts[displayCollection];
      if (!target) {
        // Create canonical product
        const insertRes = await client.query(`
          INSERT INTO products (vendor_id, name, collection, display_name, status, category_id)
          VALUES ($1, $2, $3, $4, 'active', $5)
          RETURNING id, name, collection, display_name, category_id
        `, [VENDOR_ID, match.canonical, displayCollection, displayCollection, orphan.category_id]);
        target = insertRes.rows[0];
        target.sku_count = '0';
        canonicalProducts[displayCollection] = target;
        productsCreated++;
        console.log(`  CREATED canonical product: "${displayCollection}"`);
      }

      // Get orphan's SKU IDs before moving them
      const orphanSkuRes = await client.query(
        `SELECT id FROM skus WHERE product_id = $1`, [orphan.id]
      );
      const orphanSkuIds = orphanSkuRes.rows.map(r => r.id);

      if (orphanSkuIds.length === 0) {
        // No SKUs — just deactivate
        await client.query(`
          UPDATE products SET status = 'inactive', is_active = false, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [orphan.id]);
        merged++;
        continue;
      }

      console.log(`  MERGE: "${orphan.collection}" (${orphanSkuIds.length} SKUs) → "${displayCollection}"`);

      // 1. Move SKUs to canonical product
      const movedSkus = await client.query(`
        UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE product_id = $2
        RETURNING id
      `, [target.id, orphan.id]);
      skusMoved += movedSkus.rowCount;

      // 2. Move SKU-level media_assets
      const skuMedia = await client.query(`
        SELECT id FROM media_assets WHERE product_id = $1 AND sku_id IS NOT NULL
      `, [orphan.id]);
      for (const m of skuMedia.rows) {
        try {
          await client.query(
            `UPDATE media_assets SET product_id = $1 WHERE id = $2`,
            [target.id, m.id]
          );
          mediaMoved++;
        } catch (e) {
          if (e.code === '23505') {
            await client.query(`DELETE FROM media_assets WHERE id = $1`, [m.id]);
          } else throw e;
        }
      }

      // 3. Move product-level media_assets (delete dupes, move rest)
      const prodMedia = await client.query(`
        SELECT id FROM media_assets WHERE product_id = $1 AND sku_id IS NULL
      `, [orphan.id]);
      for (const m of prodMedia.rows) {
        try {
          await client.query(
            `UPDATE media_assets SET product_id = $1 WHERE id = $2`,
            [target.id, m.id]
          );
          mediaMoved++;
        } catch (e) {
          if (e.code === '23505') {
            await client.query(`DELETE FROM media_assets WHERE id = $1`, [m.id]);
          } else throw e;
        }
      }

      // 4. Update cart_items FK
      const cartRes = await client.query(`
        UPDATE cart_items SET product_id = $1 WHERE product_id = $2
      `, [target.id, orphan.id]);
      cartItemsUpdated += cartRes.rowCount;

      // 5. Update 'collection' sku_attribute to canonical name
      if (collectionAttrId && orphanSkuIds.length > 0) {
        const attrUpd = await client.query(`
          UPDATE sku_attributes SET value = $1
          WHERE attribute_id = $2 AND sku_id = ANY($3)
        `, [displayCollection, collectionAttrId, orphanSkuIds]);
        attrsUpdated += attrUpd.rowCount;
      }

      // 6. Deactivate orphan product
      await client.query(`
        UPDATE products SET status = 'inactive', is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [orphan.id]);

      merged++;
      if (!mergeLog[displayCollection]) mergeLog[displayCollection] = 0;
      mergeLog[displayCollection] += orphanSkuIds.length;
    }

    // ─── Summary ───────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log('\n=== DRY RUN — Rolling back ===');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('\n=== Changes committed ===');
    }

    console.log(`\nSummary:`);
    console.log(`  Orphan products merged: ${merged}`);
    console.log(`  Canonical products created: ${productsCreated}`);
    console.log(`  SKUs moved: ${skusMoved}`);
    console.log(`  Media assets moved: ${mediaMoved}`);
    console.log(`  Cart items updated: ${cartItemsUpdated}`);
    console.log(`  Collection attributes updated: ${attrsUpdated}`);
    console.log(`  Unmatched orphans: ${unmatched}`);

    if (Object.keys(mergeLog).length > 0) {
      console.log(`\nSKUs merged per canonical collection:`);
      for (const [name, count] of Object.entries(mergeLog).sort()) {
        console.log(`  ${name}: +${count} SKUs`);
      }
    }

    if (unmatchedNames.length > 0) {
      console.log(`\nUnmatched collections (review manually):`);
      for (const n of [...new Set(unmatchedNames)].sort()) {
        console.log(`  - ${n}`);
      }
    }

    // Final active product/SKU counts
    const finalRes = await client.query(`
      SELECT COUNT(DISTINCT p.id) AS products, COUNT(s.id) AS skus
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.status = 'active'
        AND p.collection LIKE 'Provenza%'
    `, [VENDOR_ID]);
    const final = finalRes.rows[0];
    console.log(`\nFinal active Provenza: ${final.products} products, ${final.skus} SKUs`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
