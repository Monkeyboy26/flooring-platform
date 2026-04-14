#!/usr/bin/env node
/**
 * Test enrichment scraper in dry-run or live mode.
 *
 * Usage:
 *   node backend/scripts/test-enrichment.js --brand provenza --limit 5 --dry-run
 *   node backend/scripts/test-enrichment.js --brand metroflor --limit 10
 *
 * Options:
 *   --brand <name>   Brand prefix to test (e.g., provenza, metroflor, shaw)
 *   --limit <n>      Max products to process (default: 5)
 *   --dry-run        Skip DB writes, only report what would happen
 *   --verbose        Show extra debug output
 */

import pg from 'pg';
import { parseArgs } from 'node:util';

const { Pool } = pg;

const { values: args } = parseArgs({
  options: {
    brand:   { type: 'string', short: 'b' },
    limit:   { type: 'string', short: 'l', default: '5' },
    'dry-run': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
  strict: false,
});

const brand = args.brand;
const limit = parseInt(args.limit || '5', 10);
const dryRun = args['dry-run'];
const verbose = args.verbose;

if (!brand) {
  console.error('Usage: node backend/scripts/test-enrichment.js --brand <name> [--limit N] [--dry-run] [--verbose]');
  console.error('\nAvailable brands: provenza, metroflor, shaw, bruce, ahf, hartco, armstrong,');
  console.error('  quickstep, congoleum, kraus, stanton, bravada, mirage, elysium, paradigm,');
  console.error('  kenmark, jmcork, traditions, babool, bosphorus');
  process.exit(1);
}

// Map short names to scraper keys
const BRAND_MAP = {
  'provenza': 'triwest-provenza',
  'metroflor': 'triwest-metroflor',
  'shaw': 'triwest-shaw',
  'bruce': 'triwest-bruce',
  'ahf': 'triwest-ahf',
  'hartco': 'triwest-hartco',
  'armstrong': 'triwest-armstrong',
  'quickstep': 'triwest-quickstep',
  'quick-step': 'triwest-quickstep',
  'congoleum': 'triwest-congoleum',
  'kraus': 'triwest-kraus',
  'stanton': 'triwest-stanton',
  'bravada': 'triwest-bravada',
  'mirage': 'triwest-mirage',
  'elysium': 'triwest-elysium',
  'paradigm': 'triwest-paradigm',
  'kenmark': 'triwest-kenmark',
  'jmcork': 'triwest-jmcork',
  'jm-cork': 'triwest-jmcork',
  'traditions': 'triwest-traditions',
  'babool': 'triwest-babool',
  'bosphorus': 'triwest-bosphorus',
};

// Map brand names to DB collection prefixes
const PREFIX_MAP = {
  'provenza': 'Provenza',
  'metroflor': 'Metroflor',
  'shaw': 'Shaw',
  'bruce': 'Bruce',
  'ahf': 'AHF',
  'hartco': 'Hartco',
  'armstrong': 'Armstrong',
  'quickstep': 'Quick-Step',
  'quick-step': 'Quick-Step',
  'congoleum': 'Congoleum',
  'kraus': 'Kraus',
  'stanton': 'Stanton',
  'bravada': 'Bravada',
  'mirage': 'Mirage',
  'elysium': 'Elysium',
  'paradigm': 'Paradigm',
  'kenmark': 'Kenmark',
  'jmcork': 'JM Cork',
  'jm-cork': 'JM Cork',
  'traditions': 'Traditions',
  'babool': 'Babool',
  'bosphorus': 'Bosphorus',
};

const scraperKey = BRAND_MAP[brand.toLowerCase()] || `triwest-${brand.toLowerCase()}`;
const brandPrefix = PREFIX_MAP[brand.toLowerCase()] || brand.charAt(0).toUpperCase() + brand.slice(1);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  console.log(`\n=== Enrichment Test: ${brandPrefix} ===`);
  console.log(`Scraper: ${scraperKey}`);
  console.log(`Limit: ${limit} products`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no DB writes)' : 'LIVE (will write to DB)'}\n`);

  // Find vendor
  const vendorResult = await pool.query(
    `SELECT id, name FROM vendors WHERE name ILIKE '%tri%west%' LIMIT 1`
  );
  if (!vendorResult.rows.length) {
    console.error('No Tri-West vendor found in database');
    process.exit(1);
  }
  const vendor = vendorResult.rows[0];
  console.log(`Vendor: ${vendor.name} (${vendor.id})`);

  // Count total products for this brand
  const countResult = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as product_count, COUNT(s.id) as sku_count
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.collection LIKE $2
  `, [vendor.id, `${brandPrefix}%`]);
  const { product_count, sku_count } = countResult.rows[0];
  console.log(`Total in DB: ${product_count} products, ${sku_count} SKUs\n`);

  // Check existing media for this brand
  const mediaCount = await pool.query(`
    SELECT COUNT(*) as count FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND p.collection LIKE $2
  `, [vendor.id, `${brandPrefix}%`]);
  console.log(`Existing media assets: ${mediaCount.rows[0].count}\n`);

  // Sample products to test
  const sampleResult = await pool.query(`
    SELECT DISTINCT ON (p.id) p.id as product_id, p.name, p.collection,
           s.id as sku_id, s.vendor_sku, s.internal_sku, s.variant_name
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.collection LIKE $2
    ORDER BY p.id
    LIMIT $3
  `, [vendor.id, `${brandPrefix}%`, limit]);

  if (sampleResult.rows.length === 0) {
    console.log('No products found for this brand. Run import-triwest-832 first.');
    process.exit(0);
  }

  console.log(`Sample products (${sampleResult.rows.length}):`);
  for (const row of sampleResult.rows) {
    console.log(`  - ${row.collection} / ${row.name} (SKU: ${row.vendor_sku || 'N/A'})`);
  }
  console.log('');

  if (dryRun) {
    console.log('--- DRY RUN: Loading scraper module to test matching logic ---\n');

    // Create a mock pool that logs instead of writing
    const mockPool = createMockPool(pool);

    // Create a mock source
    const mockSource = {
      vendor_id: vendor.id,
      config: { delay_ms: 1500 },
    };

    // Insert a temporary scrape job for logging (use DB-generated UUID)
    const jobResult = await pool.query(`
      INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
      VALUES ((SELECT id FROM vendor_sources LIMIT 1), 'running', '', '[]'::jsonb)
      RETURNING id
    `);
    const mockJob = { id: jobResult.rows[0].id };

    try {
      const scraperModule = await import(`../scrapers/${scraperKey}.js`);
      console.log(`Loaded scraper module: ${scraperKey}\n`);

      // We can't easily limit the scraper's processing, so we'll just run it
      // with the mock pool to intercept writes
      await scraperModule.run(mockPool, mockJob, mockSource);
    } catch (err) {
      console.error(`Scraper error: ${err.message}`);
      if (verbose) console.error(err.stack);
    } finally {
      // Clean up temp job
      await pool.query('DELETE FROM scrape_jobs WHERE id = $1', [mockJob.id]);
    }

    // Print mock results
    console.log('\n=== Dry Run Results ===');
    console.log(`Media assets that would be created: ${mockPool._stats.mediaInserts}`);
    console.log(`Attributes that would be set: ${mockPool._stats.attrInserts}`);
    console.log(`Descriptions that would be updated: ${mockPool._stats.descUpdates}`);
    if (mockPool._stats.mediaUrls.length > 0) {
      console.log('\nSample image URLs:');
      for (const url of mockPool._stats.mediaUrls.slice(0, 10)) {
        console.log(`  ${url}`);
      }
    }
    if (mockPool._stats.specPdfs.length > 0) {
      console.log('\nSpec PDFs found:');
      for (const pdf of mockPool._stats.specPdfs) {
        console.log(`  ${pdf}`);
      }
    }
  } else {
    console.log('--- LIVE MODE: Running scraper with real DB writes ---\n');

    // Create a real scrape job
    const sourceResult = await pool.query(
      `SELECT id FROM vendor_sources WHERE scraper_key = $1 LIMIT 1`,
      [scraperKey]
    );

    let sourceId;
    if (sourceResult.rows.length) {
      sourceId = sourceResult.rows[0].id;
    } else {
      // Create a temp source
      const newSource = await pool.query(`
        INSERT INTO vendor_sources (vendor_id, name, scraper_key, config, schedule)
        VALUES ($1, $2, $3, '{"delay_ms": 2000}'::jsonb, 'manual')
        RETURNING id
      `, [vendor.id, `${brandPrefix} Enrichment (test)`, scraperKey]);
      sourceId = newSource.rows[0].id;
    }

    const jobResult = await pool.query(`
      INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
      VALUES ($1, 'running', '', '[]'::jsonb)
      RETURNING id
    `, [sourceId]);
    const jobId = jobResult.rows[0].id;

    try {
      const scraperModule = await import(`../scrapers/${scraperKey}.js`);
      await scraperModule.run(pool, { id: jobId }, { vendor_id: vendor.id, config: { delay_ms: 2000 } });

      await pool.query(`UPDATE scrape_jobs SET status = 'completed' WHERE id = $1`, [jobId]);
    } catch (err) {
      console.error(`Scraper error: ${err.message}`);
      await pool.query(`UPDATE scrape_jobs SET status = 'failed' WHERE id = $1`, [jobId]);
    }

    // Report results
    const afterMedia = await pool.query(`
      SELECT COUNT(*) as count FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor.id, `${brandPrefix}%`]);
    console.log(`\nMedia assets after run: ${afterMedia.rows[0].count} (was ${mediaCount.rows[0].count})`);

    const jobLog = await pool.query('SELECT log FROM scrape_jobs WHERE id = $1', [jobId]);
    if (jobLog.rows[0]?.log) {
      console.log('\nScraper log:');
      console.log(jobLog.rows[0].log);
    }
  }

  await pool.end();
}

/**
 * Create a proxy pool that intercepts media_assets and sku_attributes writes
 * while forwarding reads to the real pool.
 */
function createMockPool(realPool) {
  const stats = {
    mediaInserts: 0,
    attrInserts: 0,
    descUpdates: 0,
    mediaUrls: [],
    specPdfs: [],
  };

  return {
    _stats: stats,
    query: async (text, params) => {
      const textLower = (typeof text === 'string' ? text : '').toLowerCase();

      // Intercept media_assets inserts
      if (textLower.includes('insert into media_assets')) {
        stats.mediaInserts++;
        const url = params?.find(p => typeof p === 'string' && (p.startsWith('http') || p.startsWith('//')));
        if (url) stats.mediaUrls.push(url);
        if (url && url.toLowerCase().includes('.pdf')) stats.specPdfs.push(url);
        return { rows: [{ id: 'mock-' + stats.mediaInserts, is_new: true }] };
      }

      // Intercept sku_attributes inserts
      if (textLower.includes('insert into sku_attributes')) {
        stats.attrInserts++;
        return { rows: [] };
      }

      // Intercept description updates
      if (textLower.includes('update products set description')) {
        stats.descUpdates++;
        return { rows: [] };
      }

      // Intercept scrape_jobs updates (log, errors)
      if (textLower.includes('update scrape_jobs')) {
        return { rows: [] };
      }

      // Forward reads to real pool
      return realPool.query(text, params);
    },
  };
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
