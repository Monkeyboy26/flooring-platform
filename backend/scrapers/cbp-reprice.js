import { reprice } from './bigd-reprice.js';

/**
 * Custom Building Products reprice — Big D CSP sheet → retail on the Daltile-
 * imported CBP catalog (~870 products). See bigd-reprice.js for the rules.
 *
 * CLI: docker compose exec api node scrapers/cbp-reprice.js [--dry]
 */

const CONFIG = {
  key: 'cbp',
  sheetPath: 'data/bigd-cbp-pricesheet.json',
  vendorCode: 'DAL',
  collection: 'Custom Building Products INC',
};

export async function run(pool, job, source, opts = {}) {
  return reprice(pool, job, { ...CONFIG, dry: !!opts.dry });
}

if (process.argv[1] && process.argv[1].endsWith('cbp-reprice.js')) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
  });
  try {
    await run(pool, { id: null }, null, { dry: process.argv.includes('--dry') });
  } finally {
    await pool.end();
  }
}
