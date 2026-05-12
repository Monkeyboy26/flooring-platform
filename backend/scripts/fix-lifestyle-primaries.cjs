/**
 * Fix lifestyle images incorrectly stored as primary asset_type.
 *
 * Two-phase fix:
 *   Phase 1: SKUs that have a lifestyle primary AND a non-lifestyle alternate —
 *            swap them (promote alternate to primary, demote primary to lifestyle).
 *   Phase 2: SKUs that ONLY have a lifestyle primary (no alternate to swap) —
 *            reclassify the primary to 'lifestyle'. These SKUs will still appear
 *            in the browse grid via the sku_any_images / product_any_images
 *            COALESCE fallback.
 *
 * Product-name-aware: if the matching keyword is part of the product name
 * (e.g., "Moda Living", "Gallery Grey", "Harmonist Ambiance"), it's not
 * treated as a lifestyle indicator.
 *
 * Run: docker compose exec api node scripts/fix-lifestyle-primaries.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Same keywords as base.js LIFESTYLE_KEYWORDS — detect lifestyle by filename
const LIFESTYLE_KEYWORDS = [
  'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
  'interior', 'kitchen', 'bath', 'bathroom', 'living', 'outdoor', 'pool',
  'backyard', 'application', 'install', 'showroom',
  'ambiance', 'vignette', 'hero', 'banner', 'header',
  'spotlight', 'promo', 'campaign', '1920x1080', '_4k',
  '.mp4', '.mov', '.webm',
  'amb0', 'amb1', '_amb_', '-amb-', 'amb_', 'ambi_',
  '_amb.', '-amb.', '-amb ',
  'crop_upscale',
  'ambience', 'gallery', 'roomview', 'room-view', 'insitu', 'in-situ',
  'inspiration', 'styled',
  // Italian room-scene words
  'ambiente', 'bagno', 'cucina', 'ristorante', 'terrazza', 'soggiorno',
  'camera_', 'camera-',
  'posa', 'esterno', 'ingresso', 'veranda', 'giardino',
  'pavimento', 'rivestimento', 'vetrina', 'negozio',
  'parete', 'salotto', 'ufficio', 'balcone', 'realizzazione',
  // Spanish room-scene words
  'detalle', '_bano', '-bano', 'cocina', 'proyecto',
  // Additional patterns
  ' amb ', 'restaurant', '_shop.', '_shop_',
  'beauty center', 'beauty_center', 'smart working', 'smart_working',
  // Room types
  'reception', 'lobby', 'lounge', 'hotel', 'corridor', 'patio',
  'bedroom', 'dining', 'terrace', 'garden',
  // Renders and marketing
  'render', 'rendering',
];

/**
 * Check if a URL is a lifestyle image, accounting for product name false positives.
 * @param {string} url
 * @param {string} [productName] - optional product name to exclude from matching
 * @returns {boolean}
 */
function isLifestyleUrl(url, productName, variantName) {
  const filename = url.toLowerCase().split('/').pop().split('?')[0];
  const contextLow = [productName, variantName].filter(Boolean).join(' ').toLowerCase();

  for (const kw of LIFESTYLE_KEYWORDS) {
    if (filename.includes(kw)) {
      // If keyword is part of the product/variant name, skip — it's not a lifestyle indicator
      if (contextLow.includes(kw)) continue;
      return true;
    }
  }
  return false;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all primary media_assets
    const { rows: allPrimaries } = await client.query(`
      SELECT ma.id, ma.sku_id, ma.product_id, ma.url, ma.asset_type, ma.sort_order,
             s.variant_name, p.name as product_name, v.name as vendor_name
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE ma.asset_type = 'primary'
      ORDER BY v.name, p.name, s.variant_name
    `);

    // Filter to only lifestyle URLs, passing product name for context
    const lifestyle = allPrimaries.filter(r => isLifestyleUrl(r.url, r.product_name, r.variant_name));
    console.log(`Found ${lifestyle.length} lifestyle primaries (out of ${allPrimaries.length} total primaries)\n`);

    if (!lifestyle.length) {
      console.log('Nothing to fix!');
      await client.query('ROLLBACK');
      return;
    }

    // For each lifestyle primary, check if there's a non-lifestyle alternate to swap
    let swapped = 0;
    let reclassified = 0;
    const skuIds = lifestyle.map(r => r.sku_id);

    // Fetch all alternates for these SKUs (include sort_order for swap)
    const { rows: alternates } = await client.query(`
      SELECT id, sku_id, url, asset_type, sort_order
      FROM media_assets
      WHERE sku_id = ANY($1)
        AND asset_type IN ('alternate', 'lifestyle')
      ORDER BY sku_id, asset_type, id
    `, [skuIds]);

    // Group alternates by sku_id
    const altsBySku = new Map();
    for (const alt of alternates) {
      if (!altsBySku.has(alt.sku_id)) altsBySku.set(alt.sku_id, []);
      altsBySku.get(alt.sku_id).push(alt);
    }

    // Build product name lookup for alternate checks
    const prodNameBySku = new Map();
    for (const row of lifestyle) {
      prodNameBySku.set(row.sku_id, row.product_name);
    }

    console.log('=== Phase 1: Swap lifestyle primary with product-shot alternate ===\n');

    for (const row of lifestyle) {
      const alts = altsBySku.get(row.sku_id) || [];
      // Find first non-lifestyle alternate (also product-name-aware)
      const replacement = alts.find(a => !isLifestyleUrl(a.url, row.product_name, row.variant_name));

      if (replacement) {
        swapped++;
        console.log(`  SWAP: ${row.vendor_name} / ${row.product_name} / ${row.variant_name}`);
        console.log(`    OLD primary: ${row.url.split('/').pop()}`);
        console.log(`    NEW primary: ${replacement.url.split('/').pop()}`);

        if (!DRY_RUN) {
          // Swap: demote old primary to lifestyle, promote alternate to primary.
          // Use unique negative sort_orders during intermediate steps to avoid
          // unique constraint violations on (product_id, sku_id, asset_type, sort_order).
          const oldSort = row.sort_order ?? 0;

          // Step 1: move old primary out of the way (negative sort = no collision)
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = -1000 - $1 WHERE id = $2`,
            [swapped, row.id]
          );
          // Step 2: promote alternate to primary at sort_order 0
          await client.query(
            `UPDATE media_assets SET asset_type = 'primary', sort_order = $1 WHERE id = $2`,
            [oldSort, replacement.id]
          );
          // Step 3: find a safe sort_order for the demoted image
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS max_sort FROM media_assets
             WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'`,
            [row.product_id, row.sku_id]
          );
          await client.query(
            `UPDATE media_assets SET sort_order = $1 WHERE id = $2`,
            [max_sort, row.id]
          );
        }
      }
    }

    console.log(`\nPhase 1: ${swapped} swapped\n`);
    console.log('=== Phase 2: Reclassify remaining lifestyle primaries ===\n');

    for (const row of lifestyle) {
      const alts = altsBySku.get(row.sku_id) || [];
      const replacement = alts.find(a => !isLifestyleUrl(a.url, row.product_name, row.variant_name));

      if (!replacement) {
        reclassified++;
        console.log(`  RECLASSIFY: ${row.vendor_name} / ${row.product_name} / ${row.variant_name}`);
        console.log(`    ${row.url.split('/').pop()} → lifestyle`);

        if (!DRY_RUN) {
          // Find a safe sort_order to avoid unique constraint collision
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_sort FROM media_assets
             WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'`,
            [row.product_id, row.sku_id]
          );
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [max_sort, row.id]
          );
        }
      }
    }

    console.log(`\nPhase 2: ${reclassified} reclassified\n`);
    console.log(`Total: ${swapped} swapped + ${reclassified} reclassified = ${swapped + reclassified} fixed\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] No changes made. Remove --dry-run to apply.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Done!');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
