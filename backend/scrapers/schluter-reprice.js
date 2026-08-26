import { reprice } from './bigd-reprice.js';

/**
 * Schluter reprice — Big D CSP sheet → retail on the Daltile-imported Schluter
 * catalog (~5,300 products). See bigd-reprice.js for the rules.
 *
 * CLI: docker compose exec api node scrapers/schluter-reprice.js [--dry]
 */

const CONFIG = {
  key: 'schluter',
  sheetPath: 'data/bigd-schluter-pricesheet.json',
  vendorCode: 'DAL',
  collection: 'Schluter Systems LP',
  brandCode: 'SCHLUTER', // published products live in per-line collections (Jolly, ...)
};

export async function run(pool, job, source, opts = {}) {
  return reprice(pool, job, { ...CONFIG, dry: !!opts.dry });
}

if (process.argv[1] && process.argv[1].endsWith('schluter-reprice.js')) {
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
