#!/usr/bin/env node
/**
 * fix-vanity-tops.cjs
 *
 * Fixes MSI vanity top products:
 * 1. Merges 31 products → 12 (one per collection, with size variants)
 * 2. Adds `size` attribute to each SKU
 * 3. Sets variant_name to size description (e.g., '31" x 22"', '61" x 22" Double Bowl')
 * 4. Fixes images: dedup, add missing CDN size images, remove wrong images
 * 5. Cleans up names and display_names
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
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const SIZE_ATTR_ID = 'd50e8400-e29b-41d4-a716-446655440004';

// FK tables that reference product_id and need reparenting
const FK_TABLES = [
  'media_assets', 'cart_items', 'estimate_items', 'sample_request_items',
  'trade_favorite_items', 'product_tags', 'wishlists', 'product_reviews',
  'installation_inquiries', 'order_items', 'quote_items', 'showroom_visit_items'
];

// Parse vendor_sku to extract size info
function parseVanitySize(vendorSku) {
  // VSL-ARACAR3122-2CM → 31x22
  // VSL-ARACAR6122DB-2CM → 61x22 Double Bowl
  // VSL-ARACAR6122SB-2CM → 61x22 Single Bowl
  const m = vendorSku.match(/(\d{2})(\d{2})(DB|SB)?-2CM$/i);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  const bowl = m[3] ? m[3].toUpperCase() : null;

  let label = `${w}" x ${h}"`;
  if (bowl === 'DB') label += ' Double Bowl';
  if (bowl === 'SB') label += ' Single Bowl';

  return { width: w, height: h, bowl, label, sizeOnly: `${w}" x ${h}"` };
}

// CDN image patterns by collection
function cdnImageUrl(collectionSlug, size) {
  // Most collections use: {collection}-{size}-2cm.jpg
  // Arabesque Carrara uses: arabesque-carrara-vanity-top-{size}.jpg (no -2cm, no bowl variants)
  if (collectionSlug === 'arabesque-carrara') {
    if (size.includes('single') || size.includes('double')) return null; // No bowl images
    return `https://cdn.msisurfaces.com/images/colornames/arabesque-carrara-vanity-top-${size}.jpg`;
  }
  return `https://cdn.msisurfaces.com/images/colornames/${collectionSlug}-${size}-2cm.jpg`;
}

async function main() {
  console.log(`\n=== MSI Vanity Top Fix (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  const client = await pool.connect();
  try {
    // Load all vanity top products (VSL-* SKU prefix, exclude porcelain sinks)
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.display_name, p.collection, p.is_active
      FROM products p
      WHERE p.vendor_id = $1
        AND p.is_active = true
        AND p.name ILIKE '%vanity top%'
        AND p.name NOT LIKE 'Vanity%'
      ORDER BY p.collection, p.name
    `, [VENDOR_ID]);

    console.log(`  Vanity top products found: ${products.length}`);

    // Load their SKUs
    const productIds = products.map(p => p.id);
    const { rows: skus } = await client.query(`
      SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type, s.sell_by
      FROM skus s
      WHERE s.product_id = ANY($1::uuid[])
        AND s.status = 'active'
      ORDER BY s.vendor_sku
    `, [productIds]);

    console.log(`  SKUs found: ${skus.length}`);

    // Group products by collection (normalize Arabes/Arabesque)
    const collectionGroups = new Map();
    for (const p of products) {
      let coll = p.collection;
      // Normalize "Arabes Carrara" → "Arabesque Carrara"
      if (coll === 'Arabes Carrara') coll = 'Arabesque Carrara';
      if (!collectionGroups.has(coll)) collectionGroups.set(coll, []);
      collectionGroups.get(coll).push(p);
    }

    console.log(`  Collections: ${collectionGroups.size}\n`);

    // For each collection, determine target product and source products
    const merges = [];
    for (const [coll, prods] of collectionGroups) {
      // Target = product without "Dbl Bwl", "Sgl Bwl", "Sb" suffix (the base product)
      const base = prods.find(p => !/(Dbl Bwl|Sgl Bwl|\bSb\b)/i.test(p.name));
      if (!base) {
        console.log(`  WARNING: No base product for collection "${coll}"`);
        continue;
      }
      const sources = prods.filter(p => p.id !== base.id);
      const collSkus = skus.filter(s => prods.some(p => p.id === s.product_id));

      merges.push({
        collection: coll,
        target: base,
        sources,
        skus: collSkus,
      });

      console.log(`  ${coll}: target="${base.name}" (${base.id})`);
      for (const src of sources) {
        const srcSkuCount = skus.filter(s => s.product_id === src.id).length;
        console.log(`    merge ← "${src.name}" (${srcSkuCount} SKUs)`);
      }
    }

    // Load existing media_assets
    const { rows: existingMedia } = await client.query(`
      SELECT id, product_id, url, asset_type, sort_order
      FROM media_assets
      WHERE product_id = ANY($1::uuid[])
      ORDER BY product_id, asset_type, sort_order
    `, [productIds]);

    console.log(`\n  Total media assets: ${existingMedia.length}`);

    if (DRY_RUN) {
      // Show what would happen
      console.log(`\n  --- Planned Changes ---`);
      for (const m of merges) {
        console.log(`\n  [${m.collection}]`);
        for (const sku of m.skus) {
          const parsed = parseVanitySize(sku.vendor_sku);
          console.log(`    SKU ${sku.vendor_sku}: variant_name "${sku.variant_name}" → "${parsed?.label || '???'}"`);
        }
        if (m.sources.length > 0) {
          console.log(`    Deactivate: ${m.sources.map(s => `"${s.name}"`).join(', ')}`);
        }
      }
      console.log(`\n  DRY RUN — no changes made.\n`);
      return;
    }

    // Execute
    await client.query('BEGIN');

    for (const m of merges) {
      const targetId = m.target.id;

      // Step 1: Move SKUs from source products to target
      for (const src of m.sources) {
        await client.query(
          `UPDATE skus SET product_id = $1 WHERE product_id = $2 AND status = 'active'`,
          [targetId, src.id]
        );
      }

      // Step 2: Reparent FK tables (skip skus, already done)
      for (const src of m.sources) {
        for (const table of FK_TABLES) {
          try {
            // For media_assets, we'll handle separately to avoid duplicates
            if (table === 'media_assets') continue;
            await client.query(
              `UPDATE ${table} SET product_id = $1 WHERE product_id = $2`,
              [targetId, src.id]
            );
          } catch (e) {
            // Table might not have matching rows, that's fine
          }
        }
      }

      // Step 3: Handle media_assets — move + deduplicate
      const sourceIds = m.sources.map(s => s.id);
      if (sourceIds.length > 0) {
        // Move non-duplicate media from sources to target
        const { rows: sourceMedia } = await client.query(`
          SELECT id, url, asset_type FROM media_assets
          WHERE product_id = ANY($1::uuid[])
        `, [sourceIds]);

        const { rows: targetMedia } = await client.query(`
          SELECT url FROM media_assets WHERE product_id = $1
        `, [targetId]);
        const targetUrls = new Set(targetMedia.map(m => m.url));

        for (const sm of sourceMedia) {
          if (targetUrls.has(sm.url)) {
            // Duplicate — delete from source
            await client.query('DELETE FROM media_assets WHERE id = $1', [sm.id]);
          } else {
            // Move to target as alternate
            const { rows: [{ max_sort }] } = await client.query(
              `SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM media_assets WHERE product_id = $1`,
              [targetId]
            );
            await client.query(
              `UPDATE media_assets SET product_id = $1, asset_type = 'alternate', sort_order = $2 WHERE id = $3`,
              [targetId, max_sort + 1, sm.id]
            );
            targetUrls.add(sm.url);
          }
        }
      }

      // Step 4: Delete wrong images (e.g., threshold images on vanity tops)
      await client.query(`
        DELETE FROM media_assets
        WHERE product_id = $1
          AND url LIKE '%threshold%'
      `, [targetId]);

      // Step 5: Add size attributes and fix variant_names
      for (const sku of m.skus) {
        const parsed = parseVanitySize(sku.vendor_sku);
        if (!parsed) {
          console.log(`    WARNING: Could not parse size from ${sku.vendor_sku}`);
          continue;
        }

        // Upsert size attribute
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
        `, [sku.id, SIZE_ATTR_ID, parsed.label]);

        // Update variant_name
        await client.query(
          `UPDATE skus SET variant_name = $1 WHERE id = $2`,
          [parsed.label, sku.id]
        );
      }

      // Step 6: Fix product name, display_name, collection
      await client.query(`
        UPDATE products SET
          name = $2,
          display_name = $3,
          collection = $4
        WHERE id = $1
      `, [targetId, `${m.collection} Vanity Top`, `${m.collection} Vanity Top`, m.collection]);

      // Step 7: Deactivate source products
      for (const src of m.sources) {
        await client.query(
          `UPDATE products SET is_active = false, status = 'inactive' WHERE id = $1`,
          [src.id]
        );
      }

      console.log(`  ✓ ${m.collection}: merged ${m.sources.length} sources, ${m.skus.length} SKUs`);
    }

    // Step 8: Add missing CDN size images for collections that have them
    const CDN_COLLECTIONS = {
      'Arabesque Carrara': 'arabesque-carrara',
      'Argento Grigio': 'argento-grigio',
      'Calacatta Lumas': 'calacatta-lumas',
      'Calacatta Nowy': 'calacatta-nowy',
      'Carrara Sky': 'carrara-sky',
      'Cosmic Sand': 'cosmic-sand',
      'Drifting Fog': 'drifting-fog',
      'Iced White': 'iced-white',
      'Sparkling Gray': 'sparkling-gray',
    };

    const SIZES_TO_CHECK = ['31x22', '37x22', '49x22', '61x22-single-bowl', '61x22-double-bowl'];

    for (const m of merges) {
      const slug = CDN_COLLECTIONS[m.collection];
      if (!slug) continue;

      // Get current images on this product
      const { rows: currentImgs } = await client.query(
        `SELECT url FROM media_assets WHERE product_id = $1`,
        [m.target.id]
      );
      const currentUrls = new Set(currentImgs.map(i => i.url));

      for (const size of SIZES_TO_CHECK) {
        const url = cdnImageUrl(slug, size);
        if (!url) continue;
        if (currentUrls.has(url)) continue;

        // Check which SKUs this product actually has
        const hasSize = m.skus.some(s => {
          const p = parseVanitySize(s.vendor_sku);
          if (!p) return false;
          if (size === '31x22') return p.width === 31;
          if (size === '37x22') return p.width === 37;
          if (size === '49x22') return p.width === 49;
          if (size === '61x22-single-bowl') return p.width === 61 && p.bowl === 'SB';
          if (size === '61x22-double-bowl') return p.width === 61 && p.bowl === 'DB';
          return false;
        });
        if (!hasSize) continue;

        const { rows: [{ max_sort }] } = await client.query(
          `SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM media_assets WHERE product_id = $1`,
          [m.target.id]
        );

        await client.query(`
          INSERT INTO media_assets (product_id, url, asset_type, sort_order)
          VALUES ($1, $2, 'alternate', $3)
        `, [m.target.id, url, max_sort + 1]);

        console.log(`    + CDN image: ${m.collection} ${size}`);
      }
    }

    // Step 9: Set primary images correctly
    // For each merged product, ensure the generic/overview image is primary
    // and size-specific images are alternates
    for (const m of merges) {
      const { rows: imgs } = await client.query(`
        SELECT id, url, asset_type, sort_order
        FROM media_assets
        WHERE product_id = $1
        ORDER BY sort_order
      `, [m.target.id]);

      if (imgs.length === 0) continue;

      // Find the generic image (no size in URL)
      const generic = imgs.find(i =>
        !i.url.match(/\d+x\d+/) && !i.url.includes('single-bowl') && !i.url.includes('double-bowl')
      );

      if (generic && generic.asset_type !== 'primary') {
        // Demote current primary
        await client.query(
          `UPDATE media_assets SET asset_type = 'alternate' WHERE product_id = $1 AND asset_type = 'primary'`,
          [m.target.id]
        );
        // Promote generic to primary
        await client.query(
          `UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`,
          [generic.id]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`\n  Changes committed successfully.`);

    // Verify
    const { rows: [{ product_count }] } = await client.query(`
      SELECT COUNT(*) as product_count
      FROM products
      WHERE vendor_id = $1 AND is_active = true AND name ILIKE '%vanity top%' AND name NOT LIKE 'Vanity%'
    `, [VENDOR_ID]);
    console.log(`\n  Active vanity top products: ${product_count}`);

    const { rows: verification } = await client.query(`
      SELECT p.name, p.collection,
        COUNT(s.id) as sku_count,
        COUNT(DISTINCT sa.value) as size_variants,
        (SELECT COUNT(*) FROM media_assets ma WHERE ma.product_id = p.id) as image_count
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $2
      WHERE p.vendor_id = $1 AND p.is_active = true AND p.name ILIKE '%vanity top%' AND p.name NOT LIKE 'Vanity%'
      GROUP BY p.id, p.name, p.collection
      ORDER BY p.collection
    `, [VENDOR_ID, SIZE_ATTR_ID]);

    console.log(`\n  --- Final State ---`);
    console.log(`  ${'Collection'.padEnd(22)} ${'SKUs'.padStart(4)} ${'Sizes'.padStart(5)} ${'Images'.padStart(6)}`);
    for (const v of verification) {
      console.log(`  ${v.collection.padEnd(22)} ${v.sku_count.toString().padStart(4)} ${v.size_variants.toString().padStart(5)} ${v.image_count.toString().padStart(6)}`);
    }

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
