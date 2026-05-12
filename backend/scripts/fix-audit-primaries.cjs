/**
 * fix-audit-primaries.cjs
 *
 * Fixes lifestyle/room-scene images incorrectly stored as primary for products
 * identified during visual audit of primary images across multiple vendors.
 *
 * Targets 12 specific media_assets across 3 vendors:
 *   - Mannington (7): Forest Park, Monogram, Park City HB, Pasadena, Vienna
 *   - ADEX USA (4): Floor collection (Hex, Hex Deco, Picket, Square)
 *   - Vellichor Floors (1): Artist Morisot
 *
 * Two-phase fix:
 *   Phase 1: If a non-lifestyle alternate exists → 3-step swap
 *   Phase 2: No alternate → reclassify primary to 'lifestyle'
 *
 * Run: node backend/scripts/fix-audit-primaries.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Media asset IDs confirmed as lifestyle-as-primary from visual audit
const TARGET_IDS = [
  // Mannington — room scenes (RSV/rs-/RS2 in URL)
  '8402303f-262d-4839-b1b5-93409c13c32e', // Forest Park / Natural
  '4ac978cd-0360-49c3-acb2-9582504ce8fa', // Monogram / Crema
  'c2cb8386-8bbe-4640-baad-dd4620c6cc51', // Monogram / Latte
  '6bf5bf0f-cdd1-4784-8275-e3561a87b3ad', // Park City HB / Alpine
  'b1f8ed66-e4c2-4d18-ad9f-bebc308660cf', // Park City HB / Snowcap
  '8563fe92-0607-46e2-a7a9-5dc4cd148793', // Pasadena / Stone
  '2c620a1e-e94b-4754-a4be-9f4fc3cebe99', // Vienna / Quartz

  // ADEX USA — Floor collection (installed floor scenes)
  '11bb6432-99b7-48fc-8c70-568f85e85007', // Hex 8 x 9 / Bone
  '1492fb83-f481-4b9d-b7df-dd3dede76e5a', // Hex Deco 8 x 9 / Azure
  '026a7cbf-0362-415f-8b13-74a1f394d4ba', // Picket 1.5 x 9 / Azure
  '133ea79b-3f01-410c-b0b6-02d151f2d6d6', // Square 7.4 x 7.4 / Black

  // Vellichor Floors — room scene
  '64905c1c-7057-438a-8727-149ebfac4de4', // Artist Morisot / 7-1/2" x 3/4"
];

// URL patterns that indicate a lifestyle/room-scene alternate (not suitable as replacement)
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
  // Mannington-specific room scene patterns
  '-rsv-', '-rsh-', '-rs-', '-rs2-', '_rs_', '_rsv_', '_rsh_', '_rs2_',
  // ADEX Floor collection — all images are installed floor scenes
  'floor-', 'floor_',
];

function isBadAlt(url) {
  const fn = url.toLowerCase().split('/').pop();
  return BAD_ALT_PATTERNS.some(p => fn.includes(p));
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch the target primaries
    const { rows: targets } = await client.query(`
      SELECT ma.id, ma.sku_id, ma.product_id, ma.url, ma.sort_order,
             s.variant_name, p.name as product_name, v.name as vendor_name
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      JOIN skus s ON s.id = ma.sku_id
      WHERE ma.id = ANY($1)
        AND ma.asset_type = 'primary'
      ORDER BY v.name, p.name, s.variant_name
    `, [TARGET_IDS]);

    console.log(`Found ${targets.length} of ${TARGET_IDS.length} targeted lifestyle primaries\n`);
    if (!targets.length) {
      console.log('Nothing to fix!');
      await client.query('ROLLBACK');
      return;
    }

    // Warn about any IDs not found
    const foundIds = new Set(targets.map(r => r.id));
    for (const id of TARGET_IDS) {
      if (!foundIds.has(id)) {
        console.log(`  WARNING: ${id} not found or not a primary`);
      }
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
        console.log(`  SWAP: [${row.vendor_name}] ${row.product_name} / ${row.variant_name}`);
        console.log(`    OLD: ${row.url.split('/').pop().substring(0, 70)}`);
        console.log(`    NEW: ${replacement.url.split('/').pop().substring(0, 70)}`);

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
        console.log(`  RECLASSIFY: [${row.vendor_name}] ${row.product_name} / ${row.variant_name}`);
        console.log(`    ${row.url.split('/').pop().substring(0, 70)}`);

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

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
