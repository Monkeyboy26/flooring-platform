#!/usr/bin/env node
/**
 * Attach Metroflor trim/transition accessories to their parent flooring products.
 *
 * Accessory types: End Cap, Flush Stair Nose, Overlap Stair Nose, Reducer, T-Molding, Quarter Round
 *
 * Parent mapping:
 *  - Inception 200 accessories → Metroflor Inception Reserve
 *  - Genesis Authentics accessories → split by color: Authentics (14) + Silhouette (14)
 *  - Inception Hawaii + Engage accessories → Metroflor Inception Hawaii
 *  - Genesis 1200 accessories → no active parent, skip
 *
 * For each accessory SKU:
 *  1. Move to parent product (product_id)
 *  2. Set variant_type = 'accessory', sell_by = 'unit'
 *  3. Set variant_name = accessory type (e.g. "End Cap")
 *  4. Store original color in matching_color attribute for per-color filtering
 *  5. Activate SKU (status = 'active')
 *  6. Move media assets
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'flooring_pim'
});

const MATCHING_COLOR_ATTR = '51f36f8a-e21e-4dff-bfbb-b016c8e9abbf';

// Map: discontinued accessory product name → { parentKey, accessoryType }
// parentKey will be resolved to product ID at runtime
const ACCESSORY_MAP = {
  // --- Inception 200 → Inception Reserve ---
  'Inception 200 End Cap 94.49':              { parentKey: 'inception-reserve', type: 'End Cap' },
  'Inception 200 Flush Stair Nose 94.49':     { parentKey: 'inception-reserve', type: 'Flush Stair Nose' },
  'Inception 200 Overlap Stair Nose 94.49':   { parentKey: 'inception-reserve', type: 'Overlap Stair Nose' },
  'Inception 200 Quarter Round 94.49':        { parentKey: 'inception-reserve', type: 'Quarter Round' },
  'Inception 200 Reducer 94.49':              { parentKey: 'inception-reserve', type: 'Reducer' },
  'Inception 200 T-molding 94.49':            { parentKey: 'inception-reserve', type: 'T-Molding' },

  // --- Genesis Authentics (28 colors = 14 Authentics + 14 Silhouette, split by color) ---
  'Genesis Authentics Coll. End Cap 94.49':           { parentKey: 'genesis-split', type: 'End Cap' },
  'Genesis Authentics Coll Flush Stair Nose 94.49':   { parentKey: 'genesis-split', type: 'Flush Stair Nose' },
  'Genesis Authentics Coll T-molding 94.49':          { parentKey: 'genesis-split', type: 'T-Molding' },
  'Genesis Authentics Coll. Reducer 94.49':           { parentKey: 'genesis-split', type: 'Reducer' },
  'Genesis Authentics Overlap Stair Nose 94.49':      { parentKey: 'genesis-split', type: 'Overlap Stair Nose' },
  'Genesis Authentics Quarter Round 94.49':           { parentKey: 'genesis-split', type: 'Quarter Round' },

  // --- Inception Hawaii accessories ---
  'Inception End Cap 72 W/shim Vinyl':                { parentKey: 'inception-hawaii', type: 'End Cap' },
  'Inception Flush Stair Nose 94 Vinyl':              { parentKey: 'inception-hawaii', type: 'Flush Stair Nose' },
  'Inception 20 Flush Stair Nose 94 Vinyl':           { parentKey: 'inception-hawaii', type: 'Flush Stair Nose' },
  'Eng Inception 20 Overlap Stair Nose 94 Vinyl':     { parentKey: 'inception-hawaii', type: 'Overlap Stair Nose' },
  'Inception Overlap Stair Nose 94 W/shim Vinyl':     { parentKey: 'inception-hawaii', type: 'Overlap Stair Nose' },
  'Inception Multi-purpose Reducer 72 W/shim Vinyl':  { parentKey: 'inception-hawaii', type: 'Reducer' },
  'Inception Quarter Round 94 Vinyl':                 { parentKey: 'inception-hawaii', type: 'Quarter Round' },
  'Inception T-molding 72 W/shim Vinyl':              { parentKey: 'inception-hawaii', type: 'T-Molding' },
  'Engage Inception 20 T-molding 72 -vinyl':          { parentKey: 'inception-hawaii', type: 'T-Molding' },

  // --- Engage Genesis (Hawaii-colored) → Inception Hawaii ---
  'Engage Genesis End Molding Vinyl 72':              { parentKey: 'inception-hawaii', type: 'End Cap' },
  'Engage Genesis Multi Purpose Reducer 72 Vinyl':    { parentKey: 'inception-hawaii', type: 'Reducer' },
  'Engage Genesis Overlap Stair Nose 94 Vinyl':       { parentKey: 'inception-hawaii', type: 'Overlap Stair Nose' },
  'Engage Genesis T-molding 72 Vinyl':                { parentKey: 'inception-hawaii', type: 'T-Molding' },

  // --- Engage single-SKU (mostly Royal Koa) → Inception Hawaii ---
  'Engage End Molding 94':        { parentKey: 'inception-hawaii', type: 'End Cap' },
  'Engage Flush Stair Nose 94':   { parentKey: 'inception-hawaii', type: 'Flush Stair Nose' },
  'Engage Overlap Stair Nose 94': { parentKey: 'inception-hawaii', type: 'Overlap Stair Nose' },
  'Engage Quarter Round 94':      { parentKey: 'inception-hawaii', type: 'Quarter Round' },
  'Engage Reducer 94':            { parentKey: 'inception-hawaii', type: 'Reducer' },
  'Engage T-molding 94':          { parentKey: 'inception-hawaii', type: 'T-Molding' },
};

// Genesis 1200 — no active parent, skip these
const SKIP_PRODUCTS = [
  'Engage Genesis 1200 End Cap 94',
  'Engage Genesis 1200 Flush Stair Nose 94',
  'Engage Genesis 1200 Overlap Stair Ns 94',
  'Engage Genesis 1200 Reducer 94',
  'Engage Genesis 1200 T-molding 94',
  'Engage Genesis 1200 Qtr Rnd',
];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---------------------------------------------------------------
    // 1. Resolve parent product IDs
    // ---------------------------------------------------------------
    const parents = {};

    const resolve = async (key, displayName) => {
      const { rows } = await client.query(
        `SELECT id FROM products WHERE display_name = $1 AND status = 'active' LIMIT 1`,
        [displayName]
      );
      if (!rows.length) throw new Error(`Parent not found: ${displayName}`);
      parents[key] = rows[0].id;
      console.log(`Parent: ${displayName} → ${rows[0].id}`);
    };

    await resolve('inception-reserve', 'Metroflor Inception Reserve');
    await resolve('inception-hawaii', 'Metroflor Inception Hawaii');
    await resolve('genesis-authentics', 'Metroflor Genesis Authentics');
    await resolve('genesis-silhouette', 'Metroflor Genesis Silhouette');

    // Get Genesis color sets for splitting
    const { rows: authRows } = await client.query(
      `SELECT DISTINCT s.variant_name FROM skus s JOIN products pr ON pr.id = s.product_id
       WHERE pr.id = $1`, [parents['genesis-authentics']]
    );
    const authenticsColors = new Set(authRows.map(r => r.variant_name));
    const { rows: silRows } = await client.query(
      `SELECT DISTINCT s.variant_name FROM skus s JOIN products pr ON pr.id = s.product_id
       WHERE pr.id = $1`, [parents['genesis-silhouette']]
    );
    const silhouetteColors = new Set(silRows.map(r => r.variant_name));

    console.log(`\nGenesis Authentics colors: ${authenticsColors.size}`);
    console.log(`Genesis Silhouette colors: ${silhouetteColors.size}`);

    // ---------------------------------------------------------------
    // 2. Process each accessory product
    // ---------------------------------------------------------------
    let totalMoved = 0;
    let totalSkipped = 0;
    const emptiedProducts = new Set();
    const stats = {};

    for (const [productName, config] of Object.entries(ACCESSORY_MAP)) {
      const { rows: accProducts } = await client.query(
        `SELECT pr.id FROM products pr WHERE pr.name = $1 AND pr.status = 'discontinued'`,
        [productName]
      );
      if (!accProducts.length) {
        console.log(`  SKIP (not found): ${productName}`);
        continue;
      }

      const accProductId = accProducts[0].id;

      // Get all SKUs from this accessory product
      const { rows: skus } = await client.query(
        `SELECT s.id, s.vendor_sku, s.variant_name FROM skus s
         WHERE s.product_id = $1`,
        [accProductId]
      );

      let moved = 0;
      for (const sku of skus) {
        let parentId;

        if (config.parentKey === 'genesis-split') {
          // Split by color: Authentics or Silhouette
          if (authenticsColors.has(sku.variant_name)) {
            parentId = parents['genesis-authentics'];
          } else if (silhouetteColors.has(sku.variant_name)) {
            parentId = parents['genesis-silhouette'];
          } else {
            console.log(`    No color match for ${sku.variant_name} (${sku.vendor_sku})`);
            totalSkipped++;
            continue;
          }
        } else {
          parentId = parents[config.parentKey];
        }

        if (!parentId) {
          console.log(`    No parent for ${config.parentKey}`);
          totalSkipped++;
          continue;
        }

        const originalColor = sku.variant_name;

        // Move SKU to parent product
        await client.query(
          `UPDATE skus SET product_id = $1, variant_type = 'accessory',
             variant_name = $3, sell_by = 'unit', status = 'active'
           WHERE id = $2`,
          [parentId, sku.id, config.type]
        );

        // Set matching_color attribute (upsert)
        await client.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3`,
          [sku.id, MATCHING_COLOR_ATTR, originalColor]
        );

        // Move media assets
        await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE sku_id = $2`,
          [parentId, sku.id]
        );

        moved++;
      }

      // Move product-level media assets
      await client.query(
        `UPDATE media_assets SET product_id = (
           SELECT product_id FROM skus WHERE id = (
             SELECT id FROM skus WHERE product_id != $1
             AND vendor_sku LIKE 'MET%' LIMIT 1
           )
         ) WHERE product_id = $1 AND sku_id IS NULL`,
        [accProductId]
      );

      emptiedProducts.add(accProductId);
      totalMoved += moved;

      const key = config.parentKey === 'genesis-split' ? 'genesis' : config.parentKey;
      stats[key] = (stats[key] || 0) + moved;

      if (moved > 0) {
        console.log(`  ${productName} → ${config.type}: ${moved} SKUs moved`);
      }
    }

    // ---------------------------------------------------------------
    // 3. Delete emptied accessory products
    // ---------------------------------------------------------------
    let deleted = 0;
    for (const pid of emptiedProducts) {
      const { rows } = await client.query(
        `SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1`, [pid]
      );
      if (parseInt(rows[0].cnt) === 0) {
        await client.query(`DELETE FROM media_assets WHERE product_id = $1`, [pid]);
        await client.query(`DELETE FROM products WHERE id = $1`, [pid]);
        deleted++;
      }
    }

    await client.query('COMMIT');

    console.log(`\n=== Results ===`);
    console.log(`Total accessory SKUs moved: ${totalMoved}`);
    console.log(`Skipped (no match): ${totalSkipped}`);
    console.log(`Emptied products deleted: ${deleted}`);
    console.log(`\nBy parent:`);
    for (const [key, count] of Object.entries(stats)) {
      console.log(`  ${key}: ${count} accessories`);
    }

    // Summary of accessories per parent product
    const { rows: summary } = await client.query(`
      SELECT pr.display_name,
        COUNT(DISTINCT CASE WHEN s.variant_type = 'accessory' THEN s.id END) as accessories,
        COUNT(DISTINCT CASE WHEN s.variant_type IS NULL OR s.variant_type != 'accessory' THEN s.id END) as colors,
        array_agg(DISTINCT s.variant_name ORDER BY s.variant_name)
          FILTER (WHERE s.variant_type = 'accessory') as accessory_types
      FROM products pr
      JOIN skus s ON s.product_id = pr.id
      WHERE pr.status = 'active'
        AND s.variant_type = 'accessory'
        AND s.vendor_sku LIKE 'MET%'
      GROUP BY pr.id, pr.display_name
      ORDER BY pr.display_name
    `);
    console.log(`\nAccessories per product:`);
    for (const r of summary) {
      console.log(`  ${r.display_name}: ${r.accessories} accessories, ${r.colors} colors`);
      console.log(`    Types: ${r.accessory_types.join(', ')}`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
