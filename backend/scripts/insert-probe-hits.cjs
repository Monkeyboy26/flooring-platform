#!/usr/bin/env node
const { Pool } = require('pg');
const hits = require('/tmp/probe-hits.json');

const pool = new Pool({
  host: 'localhost', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

async function main() {
  console.log(`Inserting ${hits.length} images from CDN probe...\n`);
  let inserted = 0;
  for (const h of hits) {
    try {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'primary', $3, $3, 0, 'scraper')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = $3, original_url = $3
      `, [h.product_id, h.sku_id, h.cdn_url]);
      inserted++;
      console.log(`  + ${h.variant_name} → ${h.cdn_url}`);
    } catch (err) {
      console.error(`  ! ${h.vendor_sku}: ${err.message}`);
    }
  }
  console.log(`\nInserted: ${inserted}`);
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
