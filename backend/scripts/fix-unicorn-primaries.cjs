/**
 * fix-unicorn-primaries.cjs
 *
 * Fixes 3 Unicorn Tile Corp "Borneo" SKUs where primaries are either a
 * catalog/spec-sheet page (Borneo.jpg) or a lifestyle room scene (boreno-Haya.jpg).
 *
 * Affected SKUs (all under product "Unicorn Tile Borneo"):
 *   - Gris 9x48:  primary = Borneo.jpg (catalog page), alt = boreno-Haya.jpg (lifestyle)
 *   - Haya 9x48:  primary = boreno-Haya.jpg (lifestyle)
 *   - Taupe 9x48: primary = Borneo.jpg (catalog page), alt = boreno-Haya.jpg (lifestyle)
 *
 * No correct product-shot alternates exist, so all images are reclassified
 * to 'lifestyle'. SKUs will have no primary, which is better than a wrong image.
 *
 * Run: node backend/scripts/fix-unicorn-primaries.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Bad URLs confirmed via visual audit
const BAD_URLS = [
  'https://unicorntiles.com/wp-content/uploads/2021/07/Borneo.jpg',       // catalog/spec page
  'https://unicorntiles.com/wp-content/uploads/2021/07/boreno-Haya.jpg',  // lifestyle room scene
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all bad images for Unicorn Tile Corp Borneo
    const { rows: targets } = await client.query(`
      SELECT ma.id, ma.sku_id, ma.product_id, ma.url, ma.asset_type, ma.sort_order,
             s.variant_name, p.name as product_name
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      JOIN skus s ON s.id = ma.sku_id
      WHERE v.name = 'Unicorn Tile Corp'
        AND ma.url = ANY($1)
      ORDER BY s.variant_name, ma.asset_type
    `, [BAD_URLS]);

    console.log(`Found ${targets.length} bad image records\n`);
    if (!targets.length) {
      console.log('Nothing to fix!');
      await client.query('ROLLBACK');
      return;
    }

    const primaries = targets.filter(r => r.asset_type === 'primary');
    const others = targets.filter(r => r.asset_type !== 'primary');

    console.log('=== Bad primaries to reclassify ===\n');
    for (const r of primaries) {
      console.log(`  ${r.product_name} / ${r.variant_name}`);
      console.log(`    ${r.url.split('/').pop()}`);
    }

    console.log(`\n=== Bad alternates to reclassify ===\n`);
    for (const r of others) {
      console.log(`  ${r.product_name} / ${r.variant_name} [${r.asset_type}]`);
      console.log(`    ${r.url.split('/').pop()}`);
    }

    if (!DRY_RUN) {
      // Reclassify all bad images to lifestyle
      for (const r of targets) {
        // Find safe sort_order in lifestyle type
        const { rows: [{ max_sort }] } = await client.query(`
          SELECT COALESCE(MAX(sort_order), -1) as max_sort
          FROM media_assets
          WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'
        `, [r.product_id, r.sku_id]);

        await client.query(`
          UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1
          WHERE id = $2
        `, [max_sort + 1, r.id]);
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`  Primaries reclassified: ${primaries.length}`);
    console.log(`  Alternates reclassified: ${others.length}`);
    console.log(`  Total fixed:            ${targets.length}`);
    console.log(`  Mode:                   ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);

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
