#!/usr/bin/env node
/**
 * Group Metroflor products, attach ATX/OTT accessories, set display names & collections.
 *
 * Steps:
 *  1. Move ATX (Attraxion) SKUs into their base dryback products as accessories
 *  2. Move OTT (Over the Top) SKUs into their base products as accessories
 *  3. Merge orphan "Smooth Tile" product into "Smooth Concrete"
 *  4. Set display_name and collection on all active Metroflor products
 *  5. Delete emptied products
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'flooring_pim'
});

// Display name mapping: raw 832 product name → clean display name
const DISPLAY_NAME_MAP = {
  'Cosmopolitan Db 12mil 6 X48': 'Cosmopolitan Dryback',
  'Cosmopolitan Plank 6 X48 12mil': 'Cosmopolitan Plank',
  'Deja New LVT Db Belgium Weave Tile': 'Deja New Belgium Weave',
  'Deja New LVT Oak Framing Plank 7 X48': 'Deja New Oak Framing 7x48',
  'Deja New LVT Oak Framing Plank 9 X60': 'Deja New Oak Framing 9x60',
  'Deja New LVT Smooth Concrete Tile 24 X24': 'Deja New Smooth Concrete',
  'Deja New LVT Smooth Tile 24 X24': 'Deja New Smooth Concrete',  // merge target
  'Double Take 20mil 12 X24': 'Double Take Tile 12x24',
  'Double Take 20mil 18 X36': 'Double Take Tile 18x36',
  'Double Take 20mil 7 X48': 'Double Take Plank 7x48',
  'French Quarter-chevron 8mm 12.05 X28.28': 'French Quarter Chevron',
  'French Quarter-plank 8mm 7.09 X59.45': 'French Quarter Plank',
  'Genesis Authentics Coll. 9 X72 - 20mil': 'Genesis Authentics',
  'Genesis Silhouette Coll. 7 X60 20mil': 'Genesis Silhouette',
  'Inception 200 Xxl 20mil W/pad 9 X72': 'Inception 200 XXL 9x72',
  'Inception Reserve 200 7 X48 W/pad 20mil': 'Inception Reserve 7x48',
  'Inception Reserve 200 9 X60 W/pad 20mil': 'Inception Reserve 9x60',
  'Inception(20) 7 X48 Dl100 - 20mil': 'Inception Hawaii',
  'Inception(200) 8.66 X59.45 - 20mil': 'Inception Reserve',
  'Performer Dry Back 7 X48 12mil Glue Down 2mm (ko)': 'Performer Dryback',
  'Studio Plus Db 12mil 6 X48 (k)': 'Studio Plus Dryback',
  'Studio Plus Plank 8mil 6 X36': 'Studio Plus Plank',
  '5mm Over the Top Oak Framing Db': 'Over The Top Oak Framing',
  '5mm Over the Top Smooth Concrete Tile 24 X24 - Db': 'Over The Top Smooth Concrete',
};

// Collection mapping: product name prefix → collection
const COLLECTION_MAP = {
  'Cosmopolitan': 'Cosmopolitan',
  'Deja New': 'Deja New',
  'Double Take': 'Double Take',
  'French Quarter': 'French Quarter',
  'Genesis Authentics': 'Genesis',
  'Genesis Silhouette': 'Genesis',
  'Inception Reserve': 'Inception Reserve',
  'Inception 200': 'Inception',
  'Inception Hawaii': 'Inception',
  'Inception(': 'Inception',
  'Performer': 'Performer',
  'Studio Plus': 'Studio Plus',
  '5mm Over': 'Over The Top',
};

function getCollection(productName) {
  for (const [prefix, collection] of Object.entries(COLLECTION_MAP)) {
    if (productName.startsWith(prefix)) return collection;
  }
  return null;
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---------------------------------------------------------------
    // 1. Build lookup of all active Metroflor SKUs
    // ---------------------------------------------------------------
    const { rows: allSkus } = await client.query(`
      SELECT s.id, s.vendor_sku, s.product_id, s.variant_name, s.variant_type,
             pr.name as product_name, pr.id as prod_id
      FROM skus s
      JOIN products pr ON pr.id = s.product_id
      WHERE s.vendor_sku LIKE 'MET%'
        AND pr.status = 'active'
    `);

    // Index base SKUs by vendor_sku (non-ATX, non-OTT)
    const baseBySku = {};
    for (const s of allSkus) {
      if (!s.vendor_sku.endsWith('ATX') && !s.vendor_sku.startsWith('METOTT')) {
        baseBySku[s.vendor_sku] = s;
      }
    }

    // ---------------------------------------------------------------
    // 2. Move ATX SKUs into base products as accessories
    // ---------------------------------------------------------------
    const atxSkus = allSkus.filter(s => s.vendor_sku.endsWith('ATX'));
    let atxMoved = 0;
    const emptiedProducts = new Set();

    for (const atx of atxSkus) {
      const baseSku = atx.vendor_sku.replace(/ATX$/, '');
      const base = baseBySku[baseSku];
      if (!base) {
        console.log(`  ATX no base match: ${atx.vendor_sku} → ${baseSku}`);
        continue;
      }
      if (base.product_id === atx.product_id) {
        // Already in same product, just ensure variant_type
        await client.query(
          `UPDATE skus SET variant_type = 'accessory' WHERE id = $1 AND (variant_type IS NULL OR variant_type != 'accessory')`,
          [atx.id]
        );
        continue;
      }

      const oldProductId = atx.product_id;

      // Move SKU to base product
      await client.query(
        `UPDATE skus SET product_id = $1, variant_type = 'accessory' WHERE id = $2`,
        [base.product_id, atx.id]
      );

      // Move media assets
      await client.query(
        `UPDATE media_assets SET product_id = $1 WHERE sku_id = $2`,
        [base.product_id, atx.id]
      );
      // Also move product-level assets from ATX product
      await client.query(
        `UPDATE media_assets SET product_id = $1 WHERE product_id = $2 AND sku_id IS NULL`,
        [base.product_id, oldProductId]
      );

      // Move sku_attributes
      // (no need — sku_attributes reference sku_id, which stays the same)

      emptiedProducts.add(oldProductId);
      atxMoved++;
    }
    console.log(`ATX accessories moved: ${atxMoved}`);

    // ---------------------------------------------------------------
    // 3. Move OTT SKUs into base products as accessories
    // ---------------------------------------------------------------
    const ottSkus = allSkus.filter(s => s.vendor_sku.startsWith('METOTT'));
    let ottMoved = 0;

    for (const ott of ottSkus) {
      // Strip MET and OTT prefix: METOTTDN123807 → METDN123807
      const baseSku = 'MET' + ott.vendor_sku.replace(/^METOTT/, '');
      const base = baseBySku[baseSku];
      if (!base) {
        console.log(`  OTT no base match: ${ott.vendor_sku} → ${baseSku}`);
        continue;
      }
      if (base.product_id === ott.product_id) {
        await client.query(
          `UPDATE skus SET variant_type = 'accessory' WHERE id = $1 AND (variant_type IS NULL OR variant_type != 'accessory')`,
          [ott.id]
        );
        continue;
      }

      const oldProductId = ott.product_id;

      await client.query(
        `UPDATE skus SET product_id = $1, variant_type = 'accessory' WHERE id = $2`,
        [base.product_id, ott.id]
      );
      await client.query(
        `UPDATE media_assets SET product_id = $1 WHERE sku_id = $2`,
        [base.product_id, ott.id]
      );
      await client.query(
        `UPDATE media_assets SET product_id = $1 WHERE product_id = $2 AND sku_id IS NULL`,
        [base.product_id, oldProductId]
      );

      emptiedProducts.add(oldProductId);
      ottMoved++;
    }
    console.log(`OTT accessories moved: ${ottMoved}`);

    // ---------------------------------------------------------------
    // 4. Merge orphan "Smooth Tile" into "Smooth Concrete"
    // ---------------------------------------------------------------
    const { rows: smoothTile } = await client.query(`
      SELECT pr.id FROM products pr
      WHERE pr.name = 'Deja New LVT Smooth Tile 24 X24'
        AND pr.status = 'active'
        AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = pr.id AND s.vendor_sku LIKE 'MET%')
    `);
    const { rows: smoothConcrete } = await client.query(`
      SELECT pr.id FROM products pr
      WHERE pr.name = 'Deja New LVT Smooth Concrete Tile 24 X24'
        AND pr.status = 'active'
        AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = pr.id AND s.vendor_sku LIKE 'MET%')
    `);

    if (smoothTile.length && smoothConcrete.length) {
      const fromId = smoothTile[0].id;
      const toId = smoothConcrete[0].id;
      await client.query(`UPDATE skus SET product_id = $1 WHERE product_id = $2`, [toId, fromId]);
      await client.query(`UPDATE media_assets SET product_id = $1 WHERE product_id = $2`, [toId, fromId]);
      emptiedProducts.add(fromId);
      console.log(`Merged "Smooth Tile" orphan into "Smooth Concrete"`);
    }

    // ---------------------------------------------------------------
    // 5. Delete emptied products (check they have no remaining SKUs)
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
      } else {
        console.log(`  Product ${pid} still has ${rows[0].cnt} SKUs, not deleting`);
      }
    }
    console.log(`Emptied products deleted: ${deleted}`);

    // ---------------------------------------------------------------
    // 6. Set display_name and collection on remaining products
    // ---------------------------------------------------------------
    const { rows: products } = await client.query(`
      SELECT DISTINCT pr.id, pr.name, pr.display_name, pr.collection
      FROM products pr
      JOIN skus s ON s.product_id = pr.id
      WHERE s.vendor_sku LIKE 'MET%'
        AND pr.status = 'active'
      ORDER BY pr.name
    `);

    let named = 0;
    for (const p of products) {
      const displayName = DISPLAY_NAME_MAP[p.name] || null;
      const collection = getCollection(p.name);

      const updates = [];
      const vals = [];
      let idx = 1;

      if (displayName && displayName !== p.display_name) {
        updates.push(`display_name = $${idx++}`);
        vals.push(displayName);
      }
      if (collection && collection !== p.collection) {
        updates.push(`collection = $${idx++}`);
        vals.push(collection);
      }

      if (updates.length) {
        vals.push(p.id);
        await client.query(
          `UPDATE products SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
          vals
        );
        named++;
        console.log(`  ${p.name} → display: "${displayName || p.display_name}", collection: "${collection || p.collection}"`);
      }
    }
    console.log(`Products updated with names/collections: ${named}`);

    // ---------------------------------------------------------------
    // 7. Summary
    // ---------------------------------------------------------------
    const { rows: summary } = await client.query(`
      SELECT
        COUNT(DISTINCT pr.id) as products,
        COUNT(DISTINCT s.id) as total_skus,
        COUNT(DISTINCT CASE WHEN s.variant_type = 'accessory' THEN s.id END) as accessory_skus,
        COUNT(DISTINCT CASE WHEN s.variant_type IS NULL OR s.variant_type != 'accessory' THEN s.id END) as color_skus
      FROM products pr
      JOIN skus s ON s.product_id = pr.id
      WHERE pr.status = 'active'
        AND EXISTS (SELECT 1 FROM skus ss WHERE ss.product_id = pr.id AND ss.vendor_sku LIKE 'MET%')
    `);
    const s = summary[0];
    console.log(`\nFinal state:`);
    console.log(`  Products: ${s.products}`);
    console.log(`  Total SKUs: ${s.total_skus}`);
    console.log(`  Color variants: ${s.color_skus}`);
    console.log(`  Accessories: ${s.accessory_skus}`);

    await client.query('COMMIT');
    console.log('\nDone!');
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
