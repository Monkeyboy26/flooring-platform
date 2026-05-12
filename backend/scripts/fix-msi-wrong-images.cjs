/**
 * fix-msi-wrong-images.cjs
 *
 * Fixes MSI Surfaces scraper data quality issue where 4 generic images from
 * unrelated products were incorrectly assigned to ~49 media_asset records
 * across many SKUs.
 *
 * Wrong images (all from different products):
 *   - premium-black-34x34x12-polished-pencil-molding.jpg (17 records, 8 as primary)
 *   - antique-white-quarter-round-58x6-molding.jpg (16 records)
 *   - arabescato-cararra-34x34x12-honed-pencil-molding.jpg (8 records)
 *   - artisan-taupe-quarter-round-58x6-mldg.jpg (8 records)
 *
 * Fix strategy:
 *   1. Delete ALL media_assets with these 4 wrong URLs for MSI Surfaces
 *   2. For 3 Whisper White SKUs that lost their primary: promote the correct
 *      whisper-white-2x6-beveled.jpg alternate to primary
 *   3. The other 5 SKUs (Bay Blue QR, Bologna Chiaro CM, Dove Gray QR,
 *      Golden Honey PM, Morning Fog QR) had NO correct images — they'll
 *      have no primary, which is better than a wrong image
 *
 * Run: node backend/scripts/fix-msi-wrong-images.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const WRONG_URLS = [
  'https://cdn.msisurfaces.com/images/mosaics/premium-black-34x34x12-polished-pencil-molding.jpg',
  'https://cdn.msisurfaces.com/images/mosaics/detail/antique-white-quarter-round-58x6-molding.jpg',
  'https://cdn.msisurfaces.com/images/mosaics/detail/arabescato-cararra-34x34x12-honed-pencil-molding.jpg',
  'https://cdn.msisurfaces.com/images/mosaics/detail/artisan-taupe-quarter-round-58x6-mldg.jpg',
];

// SKUs that have a correct alternate to promote after wrong primary is deleted
const PROMOTE_SKUS = [
  { sku_id: '1d0bb250-6fe1-4c10-8cf7-d9aa96e95ecd', name: 'Whisper White / 3X6 Glossy' },
  { sku_id: 'f9e234d2-0345-499d-8517-1caa9aa92bd0', name: 'Whisper White Arabesque / PATTERN Glossy' },
  { sku_id: '6f95aad3-775e-4306-a112-919914e8960b', name: 'Whisper White Glazed Handcrafted / 4x12' },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Find all wrong images for MSI Surfaces
    const { rows: wrongImages } = await client.query(`
      SELECT ma.id, ma.sku_id, ma.product_id, ma.url, ma.asset_type, ma.sort_order,
             p.name as product_name, s.variant_name
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      JOIN skus s ON s.id = ma.sku_id
      WHERE v.name = 'MSI Surfaces'
        AND ma.url = ANY($1)
      ORDER BY p.name, s.variant_name, ma.asset_type
    `, [WRONG_URLS]);

    console.log(`Found ${wrongImages.length} wrong image records across MSI Surfaces\n`);

    if (!wrongImages.length) {
      console.log('Nothing to fix!');
      await client.query('ROLLBACK');
      return;
    }

    // Display what we're deleting
    const primaries = wrongImages.filter(r => r.asset_type === 'primary');
    const alternates = wrongImages.filter(r => r.asset_type !== 'primary');

    console.log(`=== Wrong primaries to delete (${primaries.length}) ===\n`);
    for (const r of primaries) {
      console.log(`  ${r.product_name} / ${r.variant_name}`);
      console.log(`    ${r.url.split('/').pop()}`);
    }

    console.log(`\n=== Wrong alternates to delete (${alternates.length}) ===\n`);
    for (const r of alternates) {
      console.log(`  ${r.product_name} / ${r.variant_name} [${r.asset_type}]`);
      console.log(`    ${r.url.split('/').pop()}`);
    }

    // Step 2: Delete all wrong images
    if (!DRY_RUN) {
      const wrongIds = wrongImages.map(r => r.id);
      const { rowCount } = await client.query(`
        DELETE FROM media_assets WHERE id = ANY($1)
      `, [wrongIds]);
      console.log(`\nDeleted ${rowCount} wrong image records`);
    } else {
      console.log(`\nWould delete ${wrongImages.length} wrong image records`);
    }

    // Step 3: Promote correct alternates for Whisper White SKUs
    console.log(`\n=== Promoting correct alternates to primary ===\n`);

    for (const { sku_id, name } of PROMOTE_SKUS) {
      // Find the whisper-white-2x6-beveled.jpg alternate
      const { rows: [alt] } = await client.query(`
        SELECT id, url, sort_order
        FROM media_assets
        WHERE sku_id = $1
          AND asset_type = 'alternate'
          AND url LIKE '%whisper-white-2x6-beveled.jpg'
        LIMIT 1
      `, [sku_id]);

      if (alt) {
        console.log(`  PROMOTE: ${name}`);
        console.log(`    ${alt.url.split('/').pop()} → primary`);
        if (!DRY_RUN) {
          await client.query(`
            UPDATE media_assets SET asset_type = 'primary', sort_order = 0
            WHERE id = $1
          `, [alt.id]);
        }
      } else {
        console.log(`  WARNING: No correct alternate found for ${name}`);
      }
    }

    // Summary
    console.log(`\n=== Summary ===`);
    console.log(`  Wrong primaries deleted:   ${primaries.length}`);
    console.log(`  Wrong alternates deleted:  ${alternates.length}`);
    console.log(`  Total deleted:             ${wrongImages.length}`);
    console.log(`  Alternates promoted:       ${PROMOTE_SKUS.length}`);
    console.log(`  Mode:                      ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);

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
