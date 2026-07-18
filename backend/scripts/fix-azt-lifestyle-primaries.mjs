#!/usr/bin/env node
/**
 * One-time fix: Find AZT primary images that are lifestyle shots and swap them
 * with a non-lifestyle alternate (if available).
 */
import pg from 'pg';
import { isLifestyleUrl } from '../scrapers/base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

async function main() {
  const { rows: primaries } = await pool.query(`
    SELECT ma.id as media_id, ma.url, ma.product_id, ma.sku_id,
           s.internal_sku, p.name as product_name, p.collection
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = ma.product_id
    WHERE s.internal_sku LIKE 'AZT-%'
      AND ma.asset_type = 'primary'
  `);

  console.log(`Checking ${primaries.length} AZT primary images...`);

  const suspects = primaries.filter(r => isLifestyleUrl(r.url, r.product_name));
  console.log(`Found ${suspects.length} lifestyle primaries.`);

  if (suspects.length === 0) {
    console.log('Nothing to fix.');
    await pool.end();
    return;
  }

  let fixed = 0, kept = 0;
  for (const s of suspects) {
    console.log(`\n  ${s.internal_sku} (${s.collection} – ${s.product_name})`);
    console.log(`    Current primary: ${s.url.split('/').pop().split('?')[0]}`);

    // Find non-lifestyle alternates for this SKU
    const { rows: alts } = await pool.query(`
      SELECT id, url FROM media_assets
      WHERE sku_id = $1 AND asset_type IN ('alternate', 'lifestyle')
        AND id != $2
      ORDER BY sort_order
    `, [s.sku_id, s.media_id]);

    const goodAlt = alts.find(r => !isLifestyleUrl(r.url, s.product_name));

    if (goodAlt) {
      console.log(`    Promoting: ${goodAlt.url.split('/').pop().split('?')[0]}`);
      await pool.query(`UPDATE media_assets SET asset_type = 'lifestyle' WHERE id = $1`, [s.media_id]);
      await pool.query(`UPDATE media_assets SET asset_type = 'primary' WHERE id = $1`, [goodAlt.id]);
      fixed++;
    } else {
      console.log(`    No product shot available — keeping lifestyle as primary`);
      kept++;
    }
  }

  console.log(`\nDone. Fixed: ${fixed}, Kept (no alternative): ${kept}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
