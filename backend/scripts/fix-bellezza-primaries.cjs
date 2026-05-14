/**
 * fix-bellezza-primaries.cjs
 *
 * Fixes lifestyle/room-scene images incorrectly stored as primary for Bellezza Ceramica.
 * Identified via visual audit of 357 primary images across 2 pages.
 *
 * These products have lifestyle room scenes, pool scenes, bedroom scenes, bathroom scenes,
 * or outdoor garden scenes as their primary product images. The filenames don't contain
 * standard lifestyle keywords, so the generic fix-lifestyle-primaries.cjs didn't catch them.
 *
 * Two-phase fix:
 *   Phase 1: If a non-lifestyle alternate exists → 3-step swap
 *   Phase 2: No alternate → reclassify primary to 'lifestyle'
 *
 * Run: node backend/scripts/fix-bellezza-primaries.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Products confirmed as lifestyle-as-primary from visual audit
// Format: product_name → reason
const LIFESTYLE_PRODUCTS = {
  'Chamonix':                       'laydown multi-tile and pool/patio scenes',
  'Spatula':                        'room scenes with furniture/outdoor',
  'Volga':                          'bedroom scenes',
  'Lingot':                         'bathroom scenes with fixtures',
  'Exterior Composite Wall Panel':  'outdoor garden/hedge scenes',
  'Docks':                          'bathroom scenes with fixtures',
  'Montblanc Gold':                 'living room scenes with furniture',
  'Marmo Marfil':                   'bedroom scenes',
  'Frammenti':                      'stairs/room scene (all share same image)',
  'Grunge':                         'bedroom/room scenes with furniture',
  'Milano Crema':                   'bathroom scene',
  'Connor Beige':                   'room scene with furniture',
  'Granby Beige':                   'outdoor scene',
  'Pearl Onyx':                     'bathroom scene',
  'Statuario Spider':               'room scene with desk/counter',
  'Sierra':                         'living room scene',
  'Arena Chiaro':                   'outdoor dining scene',
};

const PRODUCT_NAMES = Object.keys(LIFESTYLE_PRODUCTS);

// URL patterns that indicate a lifestyle/room-scene alternate (should not be used as replacement)
const BAD_ALT_PATTERNS = [
  'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
  'interior', 'kitchen', 'bathroom', 'living', 'outdoor', 'pool',
  'ambiance', 'vignette', 'hero', 'banner', 'amb0', 'amb1', '_amb_',
  'gallery', 'roomview', 'insitu', 'in-situ', 'inspiration', 'styled',
  'ambiente', 'bagno', 'cucina', 'render', 'rendering',
  'laydown', 'layout', 'livepanel',
  'context', 'hotel', 'lobby', 'lounge', 'restaurant', 'reception',
  'bedroom', 'dining', 'terrace', 'garden', 'patio', 'corridor',
  'living_room', 'showroom',
];

function isBadAlt(url) {
  const fn = url.toLowerCase().split('/').pop();
  return BAD_ALT_PATTERNS.some(p => fn.includes(p));
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all Bellezza primary images for the target products
    const { rows: targets } = await client.query(`
      SELECT ma.id, ma.sku_id, ma.product_id, ma.url, ma.sort_order,
             s.variant_name, p.name as product_name
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      JOIN skus s ON s.id = ma.sku_id
      WHERE v.name = 'Bellezza Ceramica'
        AND ma.asset_type = 'primary'
        AND ma.sort_order = 0
        AND ma.sku_id IS NOT NULL
        AND p.name = ANY($1)
      ORDER BY p.name, s.variant_name
    `, [PRODUCT_NAMES]);

    console.log(`Found ${targets.length} lifestyle primaries across ${PRODUCT_NAMES.length} products\n`);
    if (!targets.length) {
      console.log('Nothing to fix!');
      await client.query('ROLLBACK');
      return;
    }

    // Fetch all alternates for these SKUs
    const skuIds = targets.map(r => r.sku_id);
    const { rows: alternates } = await client.query(`
      SELECT id, sku_id, url, asset_type, sort_order
      FROM media_assets
      WHERE sku_id = ANY($1)
        AND asset_type IN ('alternate', 'lifestyle')
      ORDER BY sku_id, asset_type, sort_order
    `, [skuIds]);

    // Group alternates by sku_id
    const altsBySku = new Map();
    for (const alt of alternates) {
      if (!altsBySku.has(alt.sku_id)) altsBySku.set(alt.sku_id, []);
      altsBySku.get(alt.sku_id).push(alt);
    }

    let swapped = 0, reclassified = 0;

    console.log('=== Phase 1: Swap lifestyle primary with product-shot alternate ===\n');

    for (const row of targets) {
      const alts = altsBySku.get(row.sku_id) || [];
      // Find first non-lifestyle alternate
      const replacement = alts.find(a => a.asset_type === 'alternate' && !isBadAlt(a.url));

      if (replacement) {
        swapped++;
        console.log(`  SWAP: ${row.product_name} / ${row.variant_name}`);
        console.log(`    OLD: ${row.url.split('/').pop().substring(0, 60)}`);
        console.log(`    NEW: ${replacement.url.split('/').pop().substring(0, 60)}`);

        if (!DRY_RUN) {
          // 3-step swap to avoid unique constraint violations
          // Step 1: Demote old primary to lifestyle with temp negative sort_order
          await client.query(`
            UPDATE media_assets SET asset_type = 'lifestyle', sort_order = -1
            WHERE id = $1
          `, [row.id]);

          // Step 2: Promote alternate to primary at sort_order 0
          await client.query(`
            UPDATE media_assets SET asset_type = 'primary', sort_order = 0
            WHERE id = $1
          `, [replacement.id]);

          // Step 3: Find safe positive sort_order for demoted image
          const { rows: [{ max_sort }] } = await client.query(`
            SELECT COALESCE(MAX(sort_order), 0) as max_sort
            FROM media_assets
            WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'
              AND sort_order >= 0
          `, [row.product_id, row.sku_id]);

          await client.query(`
            UPDATE media_assets SET sort_order = $1
            WHERE id = $2
          `, [max_sort + 1, row.id]);
        }
      }
    }

    console.log(`\n=== Phase 2: Reclassify (no alternate available) ===\n`);

    for (const row of targets) {
      const alts = altsBySku.get(row.sku_id) || [];
      const replacement = alts.find(a => a.asset_type === 'alternate' && !isBadAlt(a.url));

      if (!replacement) {
        reclassified++;
        console.log(`  RECLASSIFY: ${row.product_name} / ${row.variant_name}`);
        console.log(`    ${row.url.split('/').pop().substring(0, 60)}`);

        if (!DRY_RUN) {
          // Find safe sort_order in lifestyle type
          const { rows: [{ max_sort }] } = await client.query(`
            SELECT COALESCE(MAX(sort_order), -1) as max_sort
            FROM media_assets
            WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'
          `, [row.product_id, row.sku_id]);

          await client.query(`
            UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1
            WHERE id = $2
          `, [max_sort + 1, row.id]);
        }
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`  Swapped:      ${swapped}`);
    console.log(`  Reclassified: ${reclassified}`);
    console.log(`  Total fixed:  ${swapped + reclassified}`);
    console.log(`  Mode:         ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\nDry run — rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\nCommitted!');
    }

    // Also fix product-level primaries for the same products
    const { rows: prodPrimaries } = await client.query(`
      SELECT ma.id, ma.product_id, ma.url, p.name as product_name
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.name = 'Bellezza Ceramica'
        AND ma.asset_type = 'primary'
        AND ma.sku_id IS NULL
        AND p.name = ANY($1)
    `, [PRODUCT_NAMES]);

    if (prodPrimaries.length > 0) {
      console.log(`\nNote: ${prodPrimaries.length} product-level primaries also exist for these products.`);
      console.log('These may need separate attention.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
